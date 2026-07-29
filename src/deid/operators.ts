import { Faker, ru } from "@faker-js/faker";
import type { EntityType } from "./entities";
import type { MorphAdapter, MorphForm } from "./morph";
import { parseName } from "./surname";
import {
  isValidCard,
  isValidInn,
  isValidOgrn,
  isValidOgrnip,
  isValidSnils,
} from "./checksums";

export type HideMode = "placeholder" | "surrogate";

export interface HideContext {
  morph?: MorphForm;
  seed: number;
  scopeSeed: number;
  taken: ReadonlySet<string>;
  sourceText: string;
}

export interface HideOperator {
  readonly mode: HideMode;
  render(type: EntityType, token: string, raw: string, ctx: HideContext): string;
}

export interface FakerLike {
  seed(value: number): void;
  person: {
    lastName(sex?: "female" | "male"): string;
    firstName(sex?: "female" | "male"): string;
    middleName(sex?: "female" | "male"): string;
  };
  company: { name(): string };
  internet: { email(): string };
  location: { streetAddress(): string };
}

export function createPlaceholderOperator(): HideOperator {
  return { mode: "placeholder", render: (_type, token) => token };
}

const digitsFrom = (seed: number, length: number): string => {
  let n = seed >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    n = (Math.imul(n ^ (n >>> 15), 1 | n) + 0x6d2b79f5) >>> 0;
    out += String(n % 10);
  }
  return out;
};

function validNumber(
  seed: number,
  length: number,
  validate: (value: string) => boolean,
  fixedPrefix = "",
): string | null {
  const mutable = Math.max(1, length - fixedPrefix.length);
  const base = `${fixedPrefix}${digitsFrom(seed, mutable)}`.slice(0, length);
  const body = base.slice(0, -2);
  for (let i = 0; i < 100; i++) {
    const candidate = `${body}${String(i).padStart(2, "0")}`.slice(-length);
    if (validate(candidate)) return candidate;
  }
  return null;
}

function replaceDigits(raw: string, seed: number): string {
  const generated = digitsFrom(seed, (raw.match(/\d/g) ?? []).length);
  let i = 0;
  return raw.replace(/\d/g, () => generated[i++]!);
}

function shiftedCoord(raw: string, seed: number): string {
  let offset = 0;
  const decimal = raw.replace(
    /([+-]?\d{1,3})([.,])(\d{3,})/gu,
    (_match, degrees: string, separator: string, fraction: string) => {
      const digits = digitsFrom(seed + offset++, fraction.length);
      return `${degrees}${separator}${digits === "0".repeat(fraction.length) ? `1${digits.slice(1)}` : digits}`;
    },
  );
  if (decimal !== raw) return decimal;
  return raw.replace(
    /(\d{1,3}\s*°\s*)(\d{1,2})(\s*['′])(?:\s*(\d{1,2})(?:[.,](\d+))?\s*["″])?/gu,
    (_match, degrees: string, _minutes: string, quote: string, seconds?: string, fraction?: string) => {
      const minutes = String((seed + offset++) % 60).padStart(2, "0");
      if (seconds === undefined) return `${degrees}${minutes}${quote}`;
      const sec = String((seed + offset++) % 60).padStart(2, "0");
      const tail = fraction ? `.${digitsFrom(seed + offset++, fraction.length)}` : "";
      return `${degrees}${minutes}${quote} ${sec}${tail}"`;
    },
  );
}

function shiftedDate(raw: string, scopeSeed: number): string | null {
  const m = /^(\d{1,2})([./])(\d{1,2})\2(\d{2,4})$/u.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  let date: Date;
  let format: (d: Date) => string;
  const delta = scopeSeed % 731 - 365;
  if (m) {
    const year = Number(m[4]!.length === 2 ? `20${m[4]}` : m[4]);
    date = new Date(Date.UTC(year, Number(m[3]) - 1, Number(m[1])));
    format = (d) =>
      `${String(d.getUTCDate()).padStart(2, "0")}${m[2]}${String(d.getUTCMonth() + 1).padStart(2, "0")}${m[2]}${d.getUTCFullYear()}`;
  } else if (iso) {
    date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    format = (d) => d.toISOString().slice(0, 10);
  } else {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + delta);
  return format(date);
}

function generatedSurface(
  faker: FakerLike,
  type: EntityType,
  raw: string,
  ctx: HideContext,
): string | null {
  faker.seed(ctx.seed);
  if (type === "PER") {
    const sex = ctx.morph?.gender === "femn" ? "female" : "male";
    const initials = `${faker.person.firstName(sex)[0] ?? "А"}.${faker.person.middleName(sex)[0] ?? "В"}.`;
    return `${faker.person.lastName(sex)} ${initials}`;
  }
  if (type === "ORG") {
    const form = /^(ООО|АО|ПАО|ЗАО|ОАО|ИП|ФГУП|ГУП|МУП|НПО|НИИ|ФГБУ|ФБУ|ПК)\b/u.exec(raw)?.[1] ?? "ООО";
    return `${form} «${faker.company.name().replace(/[«»"]/g, "")}»`;
  }
  if (type === "PHONE") return replaceDigits(raw, ctx.seed);
  if (type === "EMAIL") return faker.internet.email().toLowerCase();
  if (type === "ADDR") return faker.location.streetAddress();
  if (type === "DATE") return shiftedDate(raw, ctx.scopeSeed);
  if (type === "COORD") return shiftedCoord(raw, ctx.seed);
  if (type === "INN") return validNumber(ctx.seed, raw.replace(/\D/g, "").length, isValidInn);
  if (type === "OGRN") return validNumber(ctx.seed, 13, isValidOgrn, "1");
  if (type === "OGRNIP") return validNumber(ctx.seed, 15, isValidOgrnip, "3");
  if (type === "SNILS") return validNumber(ctx.seed, 11, isValidSnils);
  if (type === "CARD") return validNumber(ctx.seed, raw.replace(/\D/g, "").length, isValidCard);
  return replaceDigits(raw, ctx.seed);
}

export function createSurrogateOperator(opts?: {
  faker?: FakerLike;
  morph?: MorphAdapter;
}): HideOperator {
  const faker = opts?.faker ?? new Faker({ locale: [ru] });
  return {
    mode: "surrogate",
    render(type, token, raw, ctx) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = generatedSurface(faker, type, raw, { ...ctx, seed: ctx.seed + attempt });
        if (!candidate) continue;
        // Вымышленная фамилия иногда совпадает с настоящей: у faker их 250, и «Иванов» среди
        // них. Тогда «обезличенный» текст по-прежнему содержит настоящую фамилию — то есть
        // суррогат не выполнил свою единственную задачу. Сверки готовой строки целиком мало:
        // она отличается инициалами и падежом («Иванов В.А.» против «Иванову И.И.»), поэтому
        // ищем в исходном тексте саму ФАМИЛИЮ — её именительный является префиксом всех
        // падежных форм, так что подстроки достаточно.
        if (type === "PER") {
          const { surname } = parseName(candidate);
          if (surname && ctx.sourceText.includes(surname)) continue;
        }
        const surface = opts?.morph?.inflect(candidate, ctx.morph ?? {}, type) ?? candidate;
        if (!ctx.taken.has(surface) && !ctx.sourceText.includes(surface)) return surface;
      }
      return token;
    },
  };
}
