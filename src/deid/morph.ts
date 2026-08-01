/**
 * Морфология поверхностей: определить форму оригинала и поставить суррогат в ту же.
 *
 * Разбор и склонение самих фамилий вынесены в `surname.ts` — там же объяснено, почему
 * поверх `lvovich` понадобился слой правил (дефисные фамилии, пол нерусских ФИО,
 * несклоняемые женские на согласный).
 */

import { cityFrom, cityIn, cityTo } from "lvovich";
import type { EntityType } from "./entities";
import {
  genderFromSurname,
  inferSurnameCase,
  inflectFullName,
  lemmatizeSurname,
  parseName,
  type GramCase,
  type Gender,
} from "./surname";

export type { GramCase } from "./surname";

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

/** Средний род в наших данных не встречается у ФИО; сводим к мужскому — как и раньше. */
function toGender(value: MorphForm["gender"]): Gender {
  return value === "femn" ? "femn" : "masc";
}

function inflectPerson(value: string, form: MorphForm): string {
  return inflectFullName(value, form.case ?? "nom", form.gender ? toGender(form.gender) : undefined);
}

export function createLocalMorphAdapter(): MorphAdapter {
  return {
    id: "local",

    analyze(raw, type) {
      if (type !== "PER") return { lemma: raw, form: {} };
      const parsed = parseName(raw);
      if (parsed.surnameIndex < 0) return { lemma: raw, form: {} };
      let gender = parsed.gender ?? "masc";
      let lemmaSurname = lemmatizeSurname(parsed.surname, gender);
      // Второй проход по полу. Пол, взятый с КОСВЕННОЙ формы фамилии, врёт: «Ковалёвой» и
      // «Ивановой» lvovich считает мужскими — и дальше склоняет их по мужскому образцу
      // («к Ковалёве»). По лемме тот же вызов отвечает верно, поэтому уточняем и пересчитываем.
      // Форманты, отчество и имя надёжнее фамилии, их вывод не трогаем.
      if (parsed.genderFrom === "surname" || parsed.genderFrom === null) {
        const byLemma = genderFromSurname(lemmaSurname);
        if (byLemma && byLemma !== gender) {
          gender = byLemma;
          lemmaSurname = lemmatizeSurname(parsed.surname, gender);
        }
      }
      const parts = [...parsed.parts];
      parts[parsed.surnameIndex] = lemmaSurname;
      return {
        // Лемма — ключ личности: «Иванову И.И.» и «Иванов И.И.» должны дать ОДИН токен и один
        // суррогат, иначе один человек появляется в документе дважды — под разными номерами
        // (модель видит двоих) или под разными вымышленными именами.
        lemma: parts.join(" "),
        form: {
          case: inferSurnameCase(parsed.surname, gender),
          gender,
          number: "sing",
        },
      };
    },

    inflect(value, form, type) {
      try {
        if (type === "PER") return inflectPerson(value, form);
        if (type === "GEO_NAME" || type === "ADDR") {
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
