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

export interface EgressReceipt {
  ts: number;
  component: string;
  entities: number;
  lowConfidence: number;
  profile: string;
  hashPostRedaction: string;
}

export interface EgressResult {
  text: string;
  receipt: EgressReceipt;
  reidentify: (reply: string) => string;
}

/**
 * profiles.ts перечисляет 'COORD'/'CASE_NUM' для geo/legal, но РЕАЛЬНЫЙ EntityType
 * в components/text-deid.ts — только PER|ORG|DATE|CASE (COORD живёт отдельно в geo/*,
 * CASE_NUM никогда не был реализован — фактическая сущность называется CASE). Сверка здесь —
 * временная, до момента, когда profiles.ts поправят под реализацию.
 */
const PROFILE_ENTITY_TYPES: Record<string, EntityType[]> = {
  base: [], // де-ид текста «выкл» у базового профиля — чистый passthrough
  geo: ["PER", "ORG", "DATE", "COORD"], // COORD теперь маскируется (detect.ts→geo/coords)
  legal: ["PER", "ORG", "DATE", "CASE"],
  // standard/strict — универсальные уровни, не привязанные к конкретной вертикали.
  // strict = максимум того, что реально детектит deid/detect.ts (суммы/адреса/телефоны —
  // детектора нет, не выдумываем — см. profiles.ts).
  standard: ["PER", "ORG"],
  strict: ["PER", "ORG", "DATE", "CASE", "COORD"],
};

const RECEIPT_RING_CAP = 50;
const receiptRing: EgressReceipt[] = [];

// Разовое предупреждение о «ложном чувстве приватности» (адверсариальный ревью C.1):
// PRIVACY_MODULE=on с профилем, который НИЧЕГО не токенизирует (base / неизвестный), —
// это passthrough (base = конверт+аудит, БЕЗ де-ид текста). Оператор должен понимать,
// что для обезличивания ФИО/координат нужен профиль geo/legal. Логируем один раз, не на ход.
let warnedNoopProfile = false;

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

/**
 * Де-идентифицирует исходящий текст ПЕРЕД облаком: детект+токенизация по активному профилю,
 * квитанция (хеш POST-редакции, не оригинала), персист аудита, ре-идентификатор для
 * ответа модели. НЕ ловит исключения tokenizeText — см. fail-closed выше.
 */
export async function deidentifyOutbound(text: string): Promise<EgressResult> {
  const profile = activeProfile();
  const types = PROFILE_ENTITY_TYPES[profile] ?? [];
  if (types.length === 0 && !warnedNoopProfile) {
    warnedNoopProfile = true;
    console.warn(
      `[privacy] PRIVACY_MODULE=on, но профиль "${profile}" НЕ де-идентифицирует текст ` +
        `(passthrough) — ФИО/координаты уходят как есть. Для обезличивания выбери профиль geo/legal.`,
    );
  }
  const vault = new TokenVault();

  const { text: deid, count, lowConfidence } = tokenizeText(text, vault, types);

  const receipt: EgressReceipt = {
    ts: Date.now(),
    component: "text-deid",
    entities: count,
    lowConfidence,
    profile,
    hashPostRedaction: createHash("sha256").update(deid).digest("hex"),
  };
  persistReceipt(receipt);

  return {
    text: deid,
    receipt,
    reidentify: (reply: string) => detokenizeText(reply, vault),
  };
}
