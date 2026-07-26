import {
  cityFrom,
  cityIn,
  cityTo,
  getLastnameGender,
  inclineLastname,
} from "lvovich";
import type { EntityType } from "./entities";

export type GramCase = "nom" | "gen" | "dat" | "acc" | "ins" | "loc";
export interface MorphForm {
  case?: GramCase;
  gender?: "masc" | "femn" | "neut";
  number?: "sing" | "plur";
}

export interface MorphAdapter {
  readonly id: "local" | "sidecar" | "noop";
  analyze(raw: string, type: EntityType): { lemma: string; form: MorphForm } | null;
  inflect(value: string, form: MorphForm, type: EntityType): string;
  agreeWithNumber?(n: number, lemma: string): string;
}

const CASES = {
  nom: "nominative",
  gen: "genitive",
  dat: "dative",
  acc: "accusative",
  ins: "instrumental",
  loc: "prepositional",
} as const;

function surnameOf(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? raw;
  return /^[А-ЯЁ]\.$/u.test(first) ? raw.trim().split(/\s+/).at(-1) ?? raw : first;
}

function inferCase(surname: string): GramCase {
  const lower = surname.toLowerCase();
  if (/(?:ову|еву|ину|ыну|скому|цкому)$/u.test(lower)) return "dat";
  if (/(?:овым|евым|иным|ыным|ским|цким)$/u.test(lower)) return "ins";
  if (/(?:ове|еве|ине|ыне|ском|цком)$/u.test(lower)) return "loc";
  if (/(?:ова|ева|ина|ына|ского|цкого)$/u.test(lower)) return "gen";
  return "nom";
}

function inflectPerson(value: string, form: MorphForm): string {
  if (!form.case || form.case === "nom") return value;
  const parts = value.split(/\s+/);
  const surnameIndex = /^[А-ЯЁ]\.$/u.test(parts[0] ?? "") ? parts.length - 1 : 0;
  const surname = parts[surnameIndex];
  if (!surname) return value;
  const gender = form.gender === "femn" ? "female" : "male";
  parts[surnameIndex] = inclineLastname(surname, CASES[form.case], gender);
  return parts.join(" ");
}

export function createLocalMorphAdapter(): MorphAdapter {
  return {
    id: "local",
    analyze(raw, type) {
      if (type !== "PER") return { lemma: raw, form: {} };
      const surname = surnameOf(raw);
      const gender = getLastnameGender(surname);
      return {
        lemma: raw,
        form: {
          case: inferCase(surname),
          gender: gender === "female" ? "femn" : "masc",
          number: "sing",
        },
      };
    },
    inflect(value, form, type) {
      try {
        if (type === "PER") return inflectPerson(value, form);
        if (type === "FIELD" || type === "ADDR") {
          if (form.case === "gen") return cityFrom(value);
          if (form.case === "dat" || form.case === "acc") return cityTo(value);
          if (form.case === "loc") return cityIn(value);
        }
      } catch {
        /* fail-open: поверхность остаётся в именительном */
      }
      return value;
    },
    agreeWithNumber(n, lemma) {
      // ponytail: локальный fallback только для частого -а; sidecar покрывает общую морфологию.
      if (!lemma.endsWith("а")) return lemma;
      const mod100 = n % 100;
      const mod10 = n % 10;
      if (mod10 === 1 && mod100 !== 11) return lemma;
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
        return `${lemma.slice(0, -1)}ы`;
      }
      return lemma.slice(0, -1);
    },
  };
}

export const NOOP_MORPH: MorphAdapter = {
  id: "noop",
  analyze: (raw) => ({ lemma: raw, form: {} }),
  inflect: (value) => value,
};
