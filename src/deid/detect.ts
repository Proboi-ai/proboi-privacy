/**
 * Де-ид текста — УРОВЕНЬ ПО УМОЛЧАНИЮ (ts-spine, без Python).
 *
 * Доменный словарь орг-форм + regex ФИО/дат/№дел. Покрывает ~80% за ~0 деп
 * (council). Высокий recall (~95% F1) = опц. Natasha-сайдкар, fallback
 * поверх этого слоя. Честное ограничение: часть PII может протечь →
 * человек-в-цикле, не слепое доверие.
 *
 * Типы: PER (ФИО) · ORG (организация) · DATE (дата) · CASE (№ дела/документа) ·
 * COORD (геокоординаты — делегируется в специализированный geo/coords).
 * confidence: 'high' — специфичный паттерн/словарь; 'medium' — эвристика по форме.
 */

import { detectCoords } from "../geo/coords";

export type EntityType = "PER" | "ORG" | "DATE" | "CASE" | "COORD";

export interface DetectedEntity {
  type: EntityType;
  raw: string;
  index: number;
  confidence: "high" | "medium";
}

// Орг-формы РФ (высокая уверенность при наличии кавычек-названия рядом)
const ORG_FORMS = [
  "ООО",
  "АО",
  "ПАО",
  "ЗАО",
  "ОАО",
  "ИП",
  "ФГУП",
  "ГУП",
  "МУП",
  "НПО",
  "НИИ",
  "ФГБУ",
  "ФБУ",
  "ПК",
];

// Месяцы (родительный падеж/основа) для дат прописью
const MONTHS =
  "январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр";

interface Rule {
  type: EntityType;
  re: RegExp;
  confidence: "high" | "medium";
}

const RULES: Rule[] = [
  // ORG: форма + «Название» (кавычки-ёлочки или прямые)
  {
    type: "ORG",
    re: new RegExp(`(?:${ORG_FORMS.join("|")})\\s+[«"][^»"]+[»"]`, "gu"),
    confidence: "high",
  },
  // CASE: арбитражное дело АXX-12345/2020
  { type: "CASE", re: /[А-Я]\d{1,2}-\d{2,6}\/\d{4}/gu, confidence: "high" },
  // CASE: № <буквенно-цифровой с минимум одной цифрой>
  { type: "CASE", re: /№\s?[А-Яа-яA-Za-z0-9][А-Яа-яA-Za-z0-9\-\/]*\d[А-Яа-яA-Za-z0-9\-\/]*/gu, confidence: "high" },
  // DATE: 12.03.2020 / 12/03/20
  { type: "DATE", re: /\b\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}\b/gu, confidence: "high" },
  // DATE: ISO 2020-03-12
  { type: "DATE", re: /\b\d{4}-\d{2}-\d{2}\b/gu, confidence: "high" },
  // DATE: 12 марта 2020 (г.)
  {
    type: "DATE",
    re: new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\w*\\s+\\d{4}(?:\\s*г\\.?)?`, "gu"),
    confidence: "high",
  },
  // PER: Фамилия И.О. / Фамилия И. О.
  // (?<!…)/(?!…) вместо \b — в JS \b работает по ASCII \w и с кириллицей ломается.
  {
    type: "PER",
    // хвостовой lookahead: инициалы НЕ предваряют фамилию (иначе это форма И.О. Фамилия)
    re: /(?<![А-Яа-яЁё])[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.(?!\s?[А-ЯЁ][а-яё])/gu,
    confidence: "high",
  },
  // PER: И.О. Фамилия
  {
    type: "PER",
    re: /(?<![А-Яа-яЁё])[А-ЯЁ]\.\s?[А-ЯЁ]\.\s?[А-ЯЁ][а-яё]+(?![а-яё])/gu,
    confidence: "high",
  },
  // PER: Фамилия Имя Отчество (отчество -вич/-вна/-ична)
  {
    type: "PER",
    re: /(?<![А-Яа-яЁё])[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:вич|вна|ична)(?![а-яё])/gu,
    confidence: "medium",
  },
];

const CONF_RANK = { high: 0, medium: 1 } as const;

/**
 * Снимает перекрытия: жадно берёт непересекающиеся спаны, предпочитая ранний,
 * затем более длинный, затем более уверенный. Годится и для мержа TS+сайдкар.
 */
export function resolveOverlaps(entities: DetectedEntity[]): DetectedEntity[] {
  const sorted = [...entities].sort(
    (a, b) =>
      a.index - b.index ||
      b.raw.length - a.raw.length ||
      CONF_RANK[a.confidence] - CONF_RANK[b.confidence],
  );
  const out: DetectedEntity[] = [];
  let end = -1;
  for (const e of sorted) {
    if (e.index >= end) {
      out.push(e);
      end = e.index + e.raw.length;
    }
  }
  return out;
}

/**
 * Детектит PII указанных типов. Разрешает перекрытия в пользу более раннего/длинного
 * матча (жадно), чтобы «Фамилия И.О.» не распалась на части.
 */
export function detectEntities(text: string, types: EntityType[]): DetectedEntity[] {
  const active = RULES.filter((r) => types.includes(r.type));
  const found: DetectedEntity[] = [];
  for (const rule of active) {
    for (const m of text.matchAll(rule.re)) {
      found.push({ type: rule.type, raw: m[0], index: m.index!, confidence: rule.confidence });
    }
  }
  // COORD не regex-правило detect.ts — делегируем в специализированный geo/coords
  // (DMS/десятичные градусы/полушария + валидация диапазона lat±90/lon±180). Координата =
  // PII (решение владельца) → токенизируем ДО облака наравне с ФИО/ORG.
  if (types.includes("COORD")) {
    for (const c of detectCoords(text)) {
      found.push({ type: "COORD", raw: c.raw, index: c.index, confidence: "high" });
    }
  }
  return resolveOverlaps(found);
}
