/**
 * Надёжный возврат оригиналов (Трек C).
 *
 * Проблема: `detokenizeText` — это один `replace` по жёсткому `\[(?:PER|ORG|…)_\d+\]`.
 * Стоит модели написать `[PER_1]` (потеряла ноль), `[**PER_01**]` (разметка внутри скобок),
 * `[per-01]` (регистр и тире) или разорвать ярлык переносом строки — оригинал не вернётся,
 * и пользователь видит висящий ярлык. Это ровно та претензия, которую прислала служба ИБ.
 *
 * Алгоритм скопирован (не подключён зависимостью) у двух проектов, независимо пришедших
 * к одной схеме: LangChain `PresidioReversibleAnonymizer` и `protectai/llm-guard` — оба
 * АРХИВИРОВАНЫ в 2026, поэтому берём идею, а не пакет.
 *
 * Уровни:
 *   0. нормализация — снять разметку и разделители внутри скобок;
 *   1. точный      — кандидат буквально совпал с выданным токеном;
 *   2. свободный   — совпал после нормализации (регистр, ведущий ноль, тире/пробел/перенос);
 *   3. нечёткий    — имя типа искажено на ≤1 правку (кириллическая «Р» вместо латинской «P»);
 *   4. морфо       — режим суррогатов, Трек B/A. Здесь только место в контракте, всегда 0.
 *
 * ГРАНИЦА НЕЧЁТКОГО УРОВНЯ (сознательно уже, чем формула §7.3 спеки).
 * Спека предлагает порог Левенштейна `min(2, floor(len/4))` на весь ярлык. На коротких
 * ярлыках это даёт расстояние 1 для НОМЕРА: `[PER_04]` оказался бы в одной правке от
 * `[PER_03]`, и при наличии в сейфе только `PER_03` мы молча подставили бы ДРУГОГО человека.
 * Спека в том же абзаце запрещает ровно это: «тихая подмена не того человека хуже, чем
 * висящий ярлык». Поэтому:
 *   • нечётко сопоставляется ТОЛЬКО имя типа (PER/ORG/…), порог 1 правка;
 *   • номер обязан совпасть точно (после снятия ведущих нулей);
 *   • неоднозначность (равное расстояние до двух типов) → НЕ восстанавливаем, в orphans.
 * Искажённый `PER` не может стать записью `ORG` — тип у результата всегда тот, что распознан.
 */

import { levenshteinWithin } from "./levenshtein";

export type RestoreTier = "exact" | "loose" | "fuzzy" | "morph";

export interface RestoreResult {
  /** Текст с подставленными оригиналами. */
  text: string;
  /** Сколько ярлыков восстановлено. */
  restored: number;
  /**
   * Ярлыки, которые похожи на наши, но привязать их не удалось.
   * Содержат только сами ярлыки (`[PER_07]`) — персональных данных здесь нет по построению.
   */
  orphans: string[];
  /** Сколько восстановлено на каждом уровне — метрика здоровья, не ПДн. */
  byTier: Record<RestoreTier, number>;
}

export interface RestoreOpts {
  /** Уровни 2–3. Выключено → поведение уровня 1, байт-в-байт как `detokenizeText`. */
  fuzzy?: boolean;
}

/** Доступ к сейфу, нужный возврату. `TokenVault` реализует его как есть. */
export interface RestoreVault {
  original(token: string): string | undefined;
  tokens(): string[];
}

/**
 * Кандидат в ярлык: что-то в квадратных скобках, не длиннее 40 символов.
 * Перенос строки внутри РАЗРЕШЁН намеренно — модель разрывает ярлык при переносе.
 * Markdown-ссылки `[текст](url)` под шаблон попадают, но не проходят разбор в §parseCandidate
 * и молча игнорируются (в orphans не попадают).
 */
const CANDIDATE_RE = /\[[^[\]]{1,40}\]/gu;

/** Разметка, которую модель дописывает ВНУТРЬ скобок: `[**PER_01**]`, `[`PER_01`]`. */
const MARKUP_CHARS = /[*`~"'«»“”‘’]/gu;
/** Разделитель между типом и номером: подчёркивание, любое тире, пробел, перенос строки. */
const SEPARATORS = /[\s_\-–—‑]+/gu;

/** Разобранный кандидат: `[ per - 01 ]` → `{ type: 'PER', num: 1 }`. */
interface Parsed {
  type: string;
  num: number;
}

/**
 * Уровень 0 — нормализация. Снимает разметку и разделители внутри скобок, приводит
 * тип к верхнему регистру, номер — к числу (ведущие нули пропадают).
 * Не разобралось в форму «буквы + цифры» → null (это не наш ярлык).
 */
function parseCandidate(candidate: string): Parsed | null {
  const inner = candidate.slice(1, -1).replace(MARKUP_CHARS, "").replace(SEPARATORS, "");
  const m = /^([A-Za-zА-Яа-яЁё]{2,12})(\d{1,6})$/u.exec(inner);
  if (!m) return null;
  return { type: m[1]!.toUpperCase(), num: parseInt(m[2]!, 10) };
}

/** Ключ индекса: тип + номер без ведущих нулей. `[PER_01]` и `[per-1]` дают один ключ. */
function keyOf(type: string, num: number): string {
  return `${type}${num}`;
}

/**
 * Индекс по выданным токенам. Строится на каждый вызов: сейф живёт долго, но ответов
 * модели на один сейф немного, а держать инвалидируемый кэш дороже, чем пересобрать Map.
 */
function buildIndex(vault: RestoreVault): { byKey: Map<string, string>; types: string[] } {
  const byKey = new Map<string, string>();
  const types = new Set<string>();
  for (const token of vault.tokens()) {
    const p = parseCandidate(token);
    if (!p) continue; // токен нестандартной формы — уровень 1 его всё равно поймает
    byKey.set(keyOf(p.type, p.num), token);
    types.add(p.type);
  }
  return { byKey, types: [...types] };
}

/**
 * Уровень 3 — нечёткий подбор ИМЕНИ ТИПА. Возвращает тип, если он ровно один на
 * минимальном расстоянии ≤1. Ничья или расстояние >1 → null (в orphans).
 */
function resolveTypeFuzzy(candidateType: string, knownTypes: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  let tied = false;
  for (const known of knownTypes) {
    const d = levenshteinWithin(candidateType, known, 1);
    if (d === null) continue; // дальше порога — не рассматриваем
    if (d < bestDist) {
      bestDist = d;
      best = known;
      tied = false;
    } else if (d === bestDist) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Возвращает оригиналы на место ярлыков.
 *
 * `opts.fuzzy` не задан → работает ТОЛЬКО уровень 1, результат байт-в-байт совпадает
 * с `detokenizeText` (проверяется тестом). Всё новое включается явно.
 */
export function restoreText(
  text: string,
  vault: RestoreVault,
  opts?: RestoreOpts,
): RestoreResult {
  const byTier: Record<RestoreTier, number> = { exact: 0, loose: 0, fuzzy: 0, morph: 0 };
  const orphans: string[] = [];
  if (!text) return { text, restored: 0, orphans, byTier };

  const fuzzy = opts?.fuzzy === true;
  const { byKey, types } = fuzzy ? buildIndex(vault) : { byKey: new Map<string, string>(), types: [] };

  const out = text.replace(CANDIDATE_RE, (candidate) => {
    // Уровень 1 — точный. Работает всегда, в том числе при выключенных уровнях 2–3.
    const exact = vault.original(candidate);
    if (exact !== undefined) {
      byTier.exact++;
      return exact;
    }
    if (!fuzzy) return candidate;

    const parsed = parseCandidate(candidate);
    if (!parsed) return candidate; // не наша форма (markdown-ссылка и т.п.) — молча мимо

    // Уровень 2 — свободный: регистр, ведущий ноль, тире/пробел/перенос, разметка внутри.
    const loose = byKey.get(keyOf(parsed.type, parsed.num));
    if (loose !== undefined) {
      const original = vault.original(loose);
      if (original !== undefined) {
        byTier.loose++;
        return original;
      }
    }

    // Уровень 3 — нечёткий: искажено ИМЯ ТИПА, номер обязан совпасть точно.
    const resolvedType = resolveTypeFuzzy(parsed.type, types);
    if (resolvedType !== null) {
      const token = byKey.get(keyOf(resolvedType, parsed.num));
      if (token !== undefined) {
        const original = vault.original(token);
        if (original !== undefined) {
          byTier.fuzzy++;
          return original;
        }
      }
    }

    // Похоже на ярлык, но привязать не к чему — оставляем как есть и честно считаем.
    orphans.push(candidate);
    return candidate;
  });

  const restored = byTier.exact + byTier.loose + byTier.fuzzy + byTier.morph;
  return { text: out, restored, orphans, byTier };
}

// ─── Показ невосстановленного пользователю (§7.5) ────────────────────────────

/** Человекочитаемые названия типов. Порядок — как в перечне сущностей. */
const TYPE_LABELS: Record<string, [string, string, string]> = {
  // [1, 2–4, 5+] — согласование с числом до Трека B делаем таблицей, а не морфологией
  PER: ["ФИО", "ФИО", "ФИО"],
  ORG: ["организация", "организации", "организаций"],
  DATE: ["дата", "даты", "дат"],
  CASE: ["номер дела", "номера дел", "номеров дел"],
  COORD: ["координата", "координаты", "координат"],
  PASSPORT: ["паспорт", "паспорта", "паспортов"],
  INN: ["ИНН", "ИНН", "ИНН"],
  PHONE: ["телефон", "телефона", "телефонов"],
};

/** Русское согласование с числом: 1 / 2–4 / 5+. Заменяется на pymorphy3 в Треке B. */
function pluralIndex(n: number): 0 | 1 | 2 {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 2;
  const mod10 = n % 10;
  if (mod10 === 1) return 0;
  if (mod10 >= 2 && mod10 <= 4) return 1;
  return 2;
}

function labelFor(type: string, n: number): string {
  const forms = TYPE_LABELS[type];
  return forms ? forms[pluralIndex(n)]! : type;
}

/**
 * Предупреждение для интерфейса: СКОЛЬКО и КАКОГО ТИПА значений не восстановилось.
 * Сами значения — ни оригиналы, ни ярлыки — не показываются: строка идёт и в интерфейс,
 * и в лог, а туда персональные данные не пишем никогда.
 *
 * Восстановилось всё → null.
 */
export function describeOrphans(r: RestoreResult): string | null {
  if (r.orphans.length === 0) return null;

  const counts = new Map<string, number>();
  for (const o of r.orphans) {
    const p = parseCandidate(o);
    const type = p ? p.type : "?";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${labelFor(type, n)}`);

  const total = r.restored + r.orphans.length;
  const n = r.orphans.length;
  const values = pluralIndex(n) === 0 ? "значение" : pluralIndex(n) === 1 ? "значения" : "значений";
  return (
    `Не удалось восстановить ${n} ${values} из ${total} — ` +
    `часть данных в ответе показана скрытой (${parts.join(", ")}).`
  );
}
