/**
 * egress-gate — тонкий мост между вызывающей стороной (хост-приложением) и
 * уже готовыми/протестированными де-ид-примитивами острова (components/text-deid.ts, vault.ts,
 * deid/detect.ts). Не переизобретает де-ид — только оборачивает его в контракт, удобный вызывающей стороне.
 *
 * Грузится ЛЕНИВО (await import) вызывающей стороной ТОЛЬКО когда PRIVACY_MODULE=on.
 * Читает env НАПРЯМУЮ (не импортирует конфиг хост-приложения) — остров остаётся изолированным
 * (см. config.ts).
 *
 * Fail-closed: если tokenizeText бросает — пробрасываем исключение наверх.
 * Вызывающий (chat()) обязан заблокировать отправку, а НЕ отправить сырой текст в открытую.
 */

import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TokenVault } from "./vault";
import { tokenizeText, detokenizeText } from "./components/text-deid";
import type { EntityType } from "./deid/detect";
import { createLocalMorphAdapter, NOOP_MORPH } from "./deid/morph";
import { createPlaceholderOperator, createSurrogateOperator, type HideMode } from "./deid/operators";
import { restoreText, type RestoreResult } from "./deid/restore";
import { PrivacyBlockedError } from "./types";
import type { VaultStore } from "./vault-store";

export interface EgressReceipt {
  ts: number;
  component: string;
  entities: number;
  lowConfidence: number;
  profile: string;
  hashPostRedaction: string;
  /** Только у квитанции возврата (`text-deid-restore`): сколько ярлыков подставлено обратно. */
  restored?: number;
  /** Только у квитанции возврата: сколько ярлыков привязать не удалось (§7.4 спеки). */
  orphans?: number;
  hideMode?: HideMode;
  replacements?: number;
}

export interface EgressResult {
  text: string;
  receipt: EgressReceipt;
  /** Возврат оригиналов. Сигнатура не менялась — все существующие вызовы целы. */
  reidentify: (reply: string) => string;
  /**
   * Возврат с отчётом: что восстановилось, на каком уровне, что осталось висеть.
   * Нужен вызывающей стороне, чтобы показать пользователю «не удалось восстановить N значений»
   * (§7.5 спеки) — через `describeOrphans` из `deid/restore`.
   * Пишет квитанцию `text-deid-restore` в аудит (счётчики, не значения).
   */
  reidentifyDetailed: (reply: string) => RestoreResult;
}

/**
 * profiles.ts перечисляет 'COORD'/'CASE_NUM' для geo/legal, но РЕАЛЬНЫЙ EntityType
 * в components/text-deid.ts — только PER|ORG|DATE|CASE|PASSPORT|INN|PHONE (COORD живёт
 * отдельно в geo/*, CASE_NUM никогда не был реализован — фактическая сущность называется
 * CASE). Сверка здесь — временная, до момента, когда profiles.ts поправят под реализацию.
 */
const PROFILE_ENTITY_TYPES: Record<string, EntityType[]> = {
  base: [], // де-ид текста «выкл» у базового профиля — чистый passthrough
  geo: ["PER", "ORG", "DATE", "COORD"], // COORD теперь маскируется (detect.ts→geo/coords)
  legal: ["PER", "ORG", "DATE", "CASE", "PASSPORT", "INN", "PHONE"], // юр.документы часто несут паспорт/ИНН/телефон стороны
  // standard/strict — универсальные уровни, не привязанные к конкретной вертикали.
  // Паспорт/ИНН/телефон добавлены в standard/strict (адрес по-прежнему без
  // regex-детектора, см. deid/detect.ts).
  standard: ["PER", "ORG", "PASSPORT", "INN", "PHONE"],
  strict: ["PER", "ORG", "DATE", "CASE", "COORD", "PASSPORT", "INN", "PHONE"],
};

const RECEIPT_RING_CAP = 50;
const receiptRing: EgressReceipt[] = [];

// Fail-closed: PRIVACY_MODULE=on с профилем, который НИЧЕГО не токенизирует (base /
// неизвестный) раньше был тихим passthrough — «приватность включена», а сырьё уходило в
// облако. Это именно то, чего опасается служба ИБ клиента. Теперь незанастроенный профиль
// БЛОКИРУЕТ ход (throw ловит вызывающую сторону → сообщение не отправляется). Легитимный
// passthrough (локальная модель — «маскировать нечего»; или заведомо не-ПДн) включается
// ЯВНО оператором: PRIVACY_ALLOW_PASSTHROUGH=1. Тогда — прежнее поведение + громкий warn (раз).
let warnedNoopProfile = false;

/** Явно ли разрешён passthrough при незанастроенном профиле (локальная модель / не-ПДн). */
function passthroughExplicitlyAllowed(): boolean {
  return process.env.PRIVACY_ALLOW_PASSTHROUGH === "1";
}

/**
 * Уровни 2–3 возврата (Трек C): регистр, ведущий ноль, тире/пробел/перенос, разметка,
 * искажённое имя типа. Дефолт в КОДЕ — выкл: инвариант волны требует, чтобы без флагов
 * поведение совпадало с прежним байт-в-байт, а профиль on-prem выставляет флаг сам (§13 спеки).
 */
function restoreFuzzyEnabled(): boolean {
  return process.env.PRIVACY_RESTORE_FUZZY === "1";
}

function activeProfile(): string {
  const stateDir = process.env.STATE_DIR;
  if (stateDir) {
    try {
      const raw = readFileSync(join(stateDir, "privacy", "profile.json"), "utf8");
      const parsed = JSON.parse(raw) as { profile?: string };
      if (parsed && typeof parsed.profile === "string") return parsed.profile;
    } catch {
      /* файла нет / битый JSON — фолбэк на env */
    }
  }
  return process.env.PRIVACY_PROFILE ?? "base";
}

function persistReceipt(receipt: EgressReceipt): void {
  receiptRing.push(receipt);
  if (receiptRing.length > RECEIPT_RING_CAP) receiptRing.shift();

  const stateDir = process.env.STATE_DIR;
  if (!stateDir) return;
  try {
    const dir = join(stateDir, "privacy");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "audit.jsonl"), `${JSON.stringify(receipt)}\n`);
  } catch {
    /* аудит — best-effort; сбой записи не должен ронять ход (tamper-evident, не -proof) */
  }
}

/** Последние (до cap) квитанции из in-memory кольца — для тестов и локального дебага. */
export function recentReceipts(cap = RECEIPT_RING_CAP): EgressReceipt[] {
  return receiptRing.slice(-cap);
}

// TokenVault раньше пересоздавалась НА КАЖДЫЙ вызов deidentifyOutbound —
// если внутри одного хода PII встречалось И в userMessage, И в tool_result (вложение/PDF/vision,
// см. deidentifyToolOutput ниже), каждый вызов получал СВОЙ счётчик токенов ([PER_01] у обоих
// вызовов мог означать РАЗНЫХ людей), а reidentify() в конце хода видел только последний vault —
// токены, намайненные внутри tool_result-вызовов, не восстанавливались (пользователь видел
// "[PER_01]" буквально в ответе вместо имени). Фикс: один TokenVault на userId, живёт в памяти
// процесса МЕЖДУ вызовами (и между ходами одного юзера) — zero-knowledge инвариант не
// нарушен: vault по-прежнему никогда не сериализуется и не уходит наружу, только дольше
// живёт в RAM раннера.
const MAX_TRACKED_USERS = 500; // защита от неограниченного роста Map на долгоживущем процессе
const vaultsByUser = new Map<string, TokenVault>();

// Опциональный ПЕРСИСТЕНТНЫЙ шифрованный стор token-vault. Дефолт null → чистый in-memory
// (байт-в-байт прежнее поведение, все существующие тесты целы). Включается либо явно
// (configurePersistentVault — из bootstrap), либо лениво из env PRIVACY_VAULT_DB (см. ниже).
let persistentStore: VaultStore | null = null;
let persistentSeedKey: Uint8Array | undefined;
let vaultStoreInit: Promise<void> | null = null;

/**
 * Явно задать/сбросить персистентный стор (bootstrap раннера, где уже есть KEK). Пере-создаёт
 * per-user vaults на следующем обращении (сброс кэша), чтобы новые читали из стора.
 */
export function configurePersistentVault(store: VaultStore | null, seedKey?: Uint8Array): void {
  persistentStore = store;
  persistentSeedKey = seedKey;
  vaultStoreInit = Promise.resolve(); // env-инициализация больше не нужна
  vaultsByUser.clear();
}

/**
 * Ленивая инициализация персистентного стора из env (идемпотентно, гонко-безопасно через мемо
 * промиса). PRIVACY_VAULT_DB не задан → no-op (in-memory). Задан, но нет ДОЛГОВЕЧНОГО источника
 * KEK (PRIVACY_KEY_DIR/PRIVACY_KEK_KEYFILE) → эфемерный KEK не переживёт рестарт, поэтому НЕ
 * включаем персист (иначе после рестарта строки не расшифруются — осиротевшие токены вернулись бы).
 */
function ensurePersistentVaultFromEnv(): Promise<void> {
  if (!vaultStoreInit) vaultStoreInit = initPersistentVaultFromEnv();
  return vaultStoreInit;
}

async function initPersistentVaultFromEnv(): Promise<void> {
  if (persistentStore) return;
  const dbPath = process.env.PRIVACY_VAULT_DB;
  if (!dbPath) return;
  const keyDir = process.env.PRIVACY_KEY_DIR;
  const keyfile = process.env.PRIVACY_KEK_KEYFILE;
  if (!keyDir && !keyfile) {
    console.error(
      "[privacy] PRIVACY_VAULT_DB задан без PRIVACY_KEY_DIR/PRIVACY_KEK_KEYFILE — KEK был бы " +
        "эфемерным и персист не пережил бы рестарт; остаюсь на in-memory vault.",
    );
    return;
  }
  try {
    const { Database } = await import("bun:sqlite");
    const { sqliteVaultStore } = await import("./vault-store");
    const { createKeysComponent } = await import("./components/keys");
    const keys = createKeysComponent({ keyDir, keyfilePath: keyfile });
    const kek = await keys.getKek();
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kek));
    persistentStore = sqliteVaultStore({ db: new Database(dbPath), key: raw });
    persistentSeedKey = raw;
    console.warn(
      `[privacy] персистентный token-vault ВКЛ: ${dbPath} — на диске только шифртекст (AES-256-GCM), ` +
        `KEK из ${keyfile ? "keyfile" : "DPAPI/keyDir"}. Карта токенов переживёт рестарт.`,
    );
  } catch (err) {
    console.error(
      `[privacy] персистентный vault не поднялся (${dbPath}) — работаю на in-memory: ${err instanceof Error ? err.message : String(err)}`,
    );
    persistentStore = null;
  }
}

function getUserVault(userId: string): TokenVault {
  let vault = vaultsByUser.get(userId);
  if (!vault) {
    vault = new TokenVault(
      persistentStore
        ? { store: persistentStore, scope: userId, seedKey: persistentSeedKey }
        : { scope: userId },
    );
    vaultsByUser.set(userId, vault);
    if (vaultsByUser.size > MAX_TRACKED_USERS) {
      const oldest = vaultsByUser.keys().next().value;
      if (oldest !== undefined) vaultsByUser.delete(oldest);
    }
  }
  return vault;
}

/** Тестовый хук: сбросить все per-user vault + конфиг персиста (иначе синглтон течёт между тестами). */
export function __resetVaultsForTests(): void {
  vaultsByUser.clear();
  persistentStore = null;
  persistentSeedKey = undefined;
  vaultStoreInit = null;
}

function tokenizeForProfile(text: string, vault: TokenVault): {
  text: string;
  count: number;
  lowConfidence: number;
  profile: string;
  hideMode: HideMode;
  replacements: number;
} {
  const profile = activeProfile();
  const types = PROFILE_ENTITY_TYPES[profile] ?? [];
  if (types.length === 0) {
    // Незанастроенный профиль → fail-closed (throw), КРОМЕ явно разрешённого passthrough.
    if (!passthroughExplicitlyAllowed()) {
      throw new PrivacyBlockedError(
        "text-deid",
        `[privacy] профиль "${profile}" не де-идентифицирует текст, а PRIVACY_ALLOW_PASSTHROUGH не задан — ` +
          `отправка сырого текста ЗАБЛОКИРОВАНА (fail-closed). Выбери профиль geo/legal/standard/strict, ` +
          `либо для локальной модели явно разреши passthrough (PRIVACY_ALLOW_PASSTHROUGH=1).`,
      );
    }
    if (!warnedNoopProfile) {
      warnedNoopProfile = true;
      console.warn(
        `[privacy] PRIVACY_ALLOW_PASSTHROUGH=1 + профиль "${profile}" — де-ид ВЫКЛ (passthrough), ` +
          `ФИО/координаты уходят как есть. Допустимо только для локальной модели / заведомо не-ПДн.`,
      );
    }
  }
  const hideMode: HideMode =
    process.env.PRIVACY_HIDE_MODE === "surrogate" ? "surrogate" : "placeholder";
  const morphMode = process.env.PRIVACY_MORPH ?? "auto";
  if (hideMode === "surrogate" && morphMode === "off") {
    throw new PrivacyBlockedError("text-deid", "PRIVACY_HIDE_MODE=surrogate требует PRIVACY_MORPH");
  }
  const morph = morphMode === "off" ? NOOP_MORPH : createLocalMorphAdapter();
  const operator =
    hideMode === "surrogate" ? createSurrogateOperator({ morph }) : createPlaceholderOperator();
  const { text: deid, count, lowConfidence, replacements } = tokenizeText(
    text,
    vault,
    types,
    { operator, morph },
  );
  return { text: deid, count, lowConfidence, profile, hideMode, replacements };
}

function makeReceipt(
  component: string,
  deid: string,
  count: number,
  lowConfidence: number,
  profile: string,
  hideMode: HideMode,
  replacements: number,
): EgressReceipt {
  const receipt: EgressReceipt = {
    ts: Date.now(),
    component,
    entities: count,
    lowConfidence,
    profile,
    hideMode,
    replacements,
    hashPostRedaction: createHash("sha256").update(deid).digest("hex"),
  };
  persistReceipt(receipt);
  return receipt;
}

/**
 * Собирает пару «возврат оригиналов» для `EgressResult`.
 *
 * `reidentify` при выключенном флаге идёт СТАРЫМ путём (`detokenizeText`) — так «байт-в-байт»
 * гарантируется самим кодом, а не рассуждением о совпадении двух реализаций.
 * `reidentifyDetailed` доступен всегда: посчитать отчёт бесплатно, а показывать его
 * или нет — решает вызывающая сторона.
 */
function makeRestorers(vault: TokenVault, profile: string): Pick<EgressResult, "reidentify" | "reidentifyDetailed"> {
  const detailed = (reply: string): RestoreResult => {
    const r = restoreText(reply, vault, { fuzzy: restoreFuzzyEnabled() });
    // Квитанция возврата: ТОЛЬКО счётчики, ни оригиналов, ни ярлыков.
    persistReceipt({
      ts: Date.now(),
      component: "text-deid-restore",
      entities: r.restored + r.orphans.length,
      lowConfidence: 0,
      profile,
      hashPostRedaction: createHash("sha256").update(r.text).digest("hex"),
      restored: r.restored,
      orphans: r.orphans.length,
    });
    return r;
  };

  return {
    reidentify: (reply: string) =>
      restoreFuzzyEnabled() ? detailed(reply).text : detokenizeText(reply, vault),
    reidentifyDetailed: detailed,
  };
}

/**
 * Де-идентифицирует исходящий текст ПЕРЕД облаком: детект+токенизация по активному профилю,
 * квитанция (хеш POST-редакции, не оригинала), персист аудита, ре-идентификатор для
 * ответа модели. НЕ ловит исключения tokenizeText — см. fail-closed выше.
 *
 * userId (когда передан) выбирает ПЕРСИСТЕНТНЫЙ per-user vault (getUserVault) вместо
 * разового — так что токены, намайненные позже в этом же ходе через deidentifyToolOutput
 * (tool_result/PDF/vision), детокенизируются ТЕМ ЖЕ vault, что и reidentify() отсюда.
 * userId не передан (обратная совместимость старых вызовов/тестов) → разовый vault, как раньше.
 */
export async function deidentifyOutbound(text: string, userId?: string): Promise<EgressResult> {
  if (userId) await ensurePersistentVaultFromEnv();
  const vault = userId ? getUserVault(userId) : new TokenVault();
  const { text: deid, count, lowConfidence, profile, hideMode, replacements } =
    tokenizeForProfile(text, vault);
  const receipt = makeReceipt(
    "text-deid",
    deid,
    count,
    lowConfidence,
    profile,
    hideMode,
    replacements,
  );

  return { text: deid, receipt, ...makeRestorers(vault, profile) };
}

/**
 * Де-идентификация текста, пришедшего ОБРАТНО в контекст модели из
 * инструмента (Read/PDF-скилл/vision-описание и т.п.), а НЕ от самого пользователя. До этой
 * заплатки такой текст никогда не проходил через text-deid — ФИО/паспорт/ИНН/координаты из
 * содержимого вложения уходили в облако как есть, даже когда PRIVACY_MODULE=on и профиль
 * настроен на де-ид. Используется вызывающей стороной из PostToolUse-хука.
 * Тот же per-user vault, что и deidentifyOutbound — токены из tool_result восстановятся тем же
 * reidentify(), что и токены из userMessage.
 */
export async function deidentifyToolOutput(text: string, userId?: string): Promise<EgressResult> {
  if (userId) await ensurePersistentVaultFromEnv();
  const vault = userId ? getUserVault(userId) : new TokenVault();
  const { text: deid, count, lowConfidence, profile, hideMode, replacements } =
    tokenizeForProfile(text, vault);
  const receipt = makeReceipt(
    "text-deid-tool",
    deid,
    count,
    lowConfidence,
    profile,
    hideMode,
    replacements,
  );

  return { text: deid, receipt, ...makeRestorers(vault, profile) };
}

const MAX_WALK_DEPTH = 8; // защита от патологически вложенных/циклических tool_response

/**
 * Рекурсивно проходит ЛЮБУЮ структуру tool_response (SDK отдаёт её как `unknown` — форма
 * своя у каждого тула: {content:[...]}, {stdout,...}, произвольный JSON) и де-идентифицирует
 * КАЖДУЮ строковую «листовую» ветку через deidentifyToolOutput. Структура (объекты/массивы/
 * числа/булевы) не трогается — меняются только string-значения, чтобы не сломать контракт
 * тула для остального кода. Возвращает суммарное число задетокенизированных сущностей (0 ⇒
 * вызывающему не нужно подменять tool_response вовсе).
 */
export async function deidentifyToolResponse(
  value: unknown,
  userId?: string,
  depth = 0,
): Promise<{ value: unknown; entities: number }> {
  if (depth >= MAX_WALK_DEPTH) return { value, entities: 0 };
  if (typeof value === "string") {
    if (!value) return { value, entities: 0 };
    const r = await deidentifyToolOutput(value, userId);
    return { value: r.text, entities: r.receipt.entities };
  }
  if (Array.isArray(value)) {
    let entities = 0;
    const out: unknown[] = [];
    for (const item of value) {
      const r = await deidentifyToolResponse(item, userId, depth + 1);
      out.push(r.value);
      entities += r.entities;
    }
    return { value: out, entities };
  }
  if (value && typeof value === "object") {
    let entities = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = await deidentifyToolResponse(v, userId, depth + 1);
      out[k] = r.value;
      entities += r.entities;
    }
    return { value: out, entities };
  }
  return { value, entities: 0 };
}
