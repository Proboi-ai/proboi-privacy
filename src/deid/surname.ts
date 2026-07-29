/**
 * Разбор и склонение фамилий, включая нерусские.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СЛОЙ. `lvovich` закрывает русскую норму и часть заимствований, но на
 * замере (37 фамилий разного происхождения) выявились три класса ошибок, каждый из которых
 * портит либо текст, уходящий в модель, либо возврат оригиналов:
 *
 *   1. ДЕФИСНЫЕ. `inclineLastname('Тер-Петросян', …)` → «Тера-Петросяна»: склоняются обе
 *      части, включая неизменяемую приставку. Норма — «Тер-Петросяна».
 *   2. ПОЛ. Для нерусских фамилий `getLastnameGender` отдаёт 'androgynous'/null (Ким, Шмидт,
 *      Оганесян, Гончарук, Нгуен). Вызывающий код сводил это к «мужской», и женщина
 *      получала мужской суррогат.
 *   3. ЖЕНСКИЕ НА СОГЛАСНЫЙ. «Ким», «Оганесян», «Гончарук» у женщины НЕ склоняются
 *      («письмо Ким Ольге»), а lvovich склоняет их как мужские («Киму Ольге»).
 *
 * Всё остальное lvovich делает верно и переписыванию не подлежит: не склоняет -ко/-енко
 * (Шевченко), -ых/-их (Черных), -аго/-ово (Живаго), гласные (Гюго, Ли, Дюма, Гулиа);
 * склоняет -а/-я по первому склонению (Кафка, Данелия, Гамсахурдия) и согласные у мужчин
 * (Ким, Нгуен, Оганесян, Бек). Поэтому здесь — ТОЛЬКО надстройка над ним.
 *
 * FAIL-OPEN ПО ВСЕМУ ФАЙЛУ. Не разобрали — возвращаем как было. Ошибка склонения делает
 * текст корявым; ошибка «уверенной» подмены делает текст неверным. Второе хуже.
 */

import { getLastnameGender, inclineLastname } from "lvovich";

export type GramCase = "nom" | "gen" | "dat" | "acc" | "ins" | "loc";
export type Gender = "masc" | "femn";

/** Все падежи, кроме именительного, — по ним строятся формы для поиска и возврата. */
export const OBLIQUE_CASES: readonly GramCase[] = ["gen", "dat", "acc", "ins", "loc"];

const LVOVICH_CASE = {
  nom: "nominative",
  gen: "genitive",
  dat: "dative",
  acc: "accusative",
  ins: "instrumental",
  loc: "prepositional",
} as const;

/**
 * Неизменяемые приставки в дефисных и раздельных фамилиях. Склонять их — типовая ошибка
 * («Тера-Петросяна»). Список закрытый: расширяется по факту находки, не «на всякий случай».
 */
const INDECLINABLE_PARTS = new Set([
  "тер", "ибн", "бен", "бин", "бинт", "абу", "аль", "эль", "ад", "ас", "уль",
  "ван", "фон", "де", "ди", "да", "дю", "ла", "ле", "ли", "дель", "делла", "дер", "тен", "тон",
  "мак", "мак", "сан", "сен", "сент",
]);

/**
 * Восточные форманты отчества: «Алиев Гейдар Али оглы», «Мамедова Лейла Ариф кызы».
 * Сами не склоняются и одновременно ОДНОЗНАЧНО задают пол — это самый надёжный признак
 * пола, который вообще встречается в таких ФИО.
 */
const PATRONYMIC_MARKERS: ReadonlyArray<[RegExp, Gender]> = [
  [/^(?:оглы|оглу|огли|улы|уулу|углы)$/u, "masc"],
  [/^(?:кызы|гызы|кизи|кыз)$/u, "femn"],
];

/** Мужские имена на -а/-я: по окончанию их не отличить от женских, поэтому списком. */
const MASC_NAMES_ON_A = new Set([
  "никита", "илья", "кузьма", "фома", "лука", "савва", "данила", "гаврила",
  "сила", "вавила", "аника", "мустафа", "иса", "муса", "яхья", "хамза",
]);

/** Отчество → пол. Работает и на нерусских основах: «Абдусамаович», «Гейдаровна». */
function genderFromPatronymic(word: string): Gender | null {
  const w = word.toLowerCase().replace(/\.$/u, "");
  for (const [marker, gender] of PATRONYMIC_MARKERS) if (marker.test(w)) return gender;
  if (/(?:вна|ична|инична)$/u.test(w)) return "femn";
  if (/(?:вич|ич)$/u.test(w) && w.length > 4) return "masc";
  return null;
}

/** Имя → пол. Только там, где окончание однозначно; иначе null (fail-open). */
function genderFromGivenName(word: string): Gender | null {
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  if (MASC_NAMES_ON_A.has(w)) return "masc";
  if (/[ая]$/u.test(w)) return "femn";
  // Окончания на -ль/-нь/-ан намеренно НЕ включены: «Айгуль», «Гузель», «Айман» — женские,
  // а ошибка пола не только даёт суррогат не того рода, но и склоняет несклоняемую фамилию.
  if (/(?:ий|ей|ег|им|ил|ис|ит|ор)$/u.test(w)) return "masc";
  return null;
}

/**
 * Откуда взялся пол. Нужен вызывающему, чтобы понимать, насколько ответу можно верить:
 * формант и отчество однозначны, имя почти однозначно, а ФАМИЛИЯ — только в именительном
 * падеже (см. `genderFromSurname`).
 */
export type GenderSource = "marker" | "patronymic" | "given" | "surname" | null;

export interface ParsedName {
  /** Исходная строка без изменений. */
  raw: string;
  /** Токены по пробелам. */
  parts: string[];
  /** Индекс части, которая является фамилией; -1 — не нашли. */
  surnameIndex: number;
  surname: string;
  /** Пол, если удалось установить; иначе null. */
  gender: Gender | null;
  /** Чем пол установлен. */
  genderFrom: GenderSource;
  /** Индексы частей-формантов (оглы/кызы) — их не склоняем и не считаем именем. */
  markerIndexes: number[];
}

/**
 * Пол по ИМЕНИТЕЛЬНОЙ форме фамилии.
 *
 * Именительной — принципиально: на косвенной lvovich ошибается молча и уверенно
 * («Ковалёвой» и «Ивановой» он считает мужскими). Дальше эта ошибка не просто портит род
 * суррогата — она склоняет женскую фамилию по мужскому образцу: «к Ковалёве» вместо
 * «к Ковалёвой». Поэтому вызывать только на лемме.
 */
export function genderFromSurname(nominative: string): Gender | null {
  const g = getLastnameGender(nominative);
  return g === "female" ? "femn" : g === "male" ? "masc" : null;
}

/**
 * Инициалы во всех встречающихся написаниях: «И.», «И.И.», «И. И.», «ИИ».
 * Без точек тоже считаем инициалами — в отчётах форма «Иванов ИИ» встречается регулярно.
 */
const INITIAL_RE = /^(?:[А-ЯЁA-Z]\.){1,3}$|^[А-ЯЁA-Z]{1,3}\.?$/u;

/**
 * Разбирает ФИО в любой из встречающихся в документах форм:
 *   «Иванов И.И.» · «И.И. Иванов» · «Иванов Иван Иванович» · «Иванов ИИ» ·
 *   «Алиев Гейдар Али оглы» · «Тер-Петросян А.Б.» · «Ким Ольга Сергеевна».
 *
 * Фамилия ищется так: единственная неинициальная часть → она; есть инициалы → соседняя с
 * ними неинициальная; три слова без инициалов → первое, если последнее похоже на отчество
 * (русский порядок Ф-И-О), иначе тоже первое (в документах порядок «фамилия первой»).
 */
export function parseName(raw: string): ParsedName {
  const parts = raw.trim().split(/\s+/u).filter(Boolean);
  const markerIndexes: number[] = [];
  let gender: Gender | null = null;
  let genderFrom: GenderSource = null;

  for (const [i, part] of parts.entries()) {
    const marked = PATRONYMIC_MARKERS.find(([re]) => re.test(part.toLowerCase()));
    if (marked) {
      markerIndexes.push(i);
      if (!gender) {
        gender = marked[1];
        genderFrom = "marker";
      }
    }
  }

  const wordIndexes = parts
    .map((part, i) => ({ part, i }))
    .filter(({ part, i }) => !INITIAL_RE.test(part) && !markerIndexes.includes(i))
    .map(({ i }) => i);

  const surnameIndex = wordIndexes.length === 0 ? -1 : wordIndexes[0]!;

  // Пол: сначала форманты (уже учтены), затем отчество, затем имя, затем сама фамилия.
  if (!gender) {
    for (const i of wordIndexes.slice(1)) {
      gender = genderFromPatronymic(parts[i]!);
      if (gender) {
        genderFrom = "patronymic";
        break;
      }
    }
  }
  if (!gender && wordIndexes.length > 1) {
    gender = genderFromGivenName(parts[wordIndexes[1]!]!);
    if (gender) genderFrom = "given";
  }
  if (!gender && surnameIndex >= 0) {
    gender = genderFromSurname(parts[surnameIndex]!);
    if (gender) genderFrom = "surname";
  }

  return {
    raw,
    parts,
    surnameIndex,
    surname: surnameIndex >= 0 ? parts[surnameIndex]! : "",
    gender,
    genderFrom,
    markerIndexes,
  };
}

/**
 * Женская фамилия склоняется, только если оканчивается на -а/-я. Всё остальное —
 * согласные (Ким, Шмидт, Гончарук, Оганесян, Нгуен), -о (Шевченко), -и/-у/-е — неизменяемо.
 * Мужские классы уже корректно разобраны в lvovich, поэтому для них здесь ничего нет.
 */
function isIndeclinableForGender(part: string, gender: Gender): boolean {
  return gender === "femn" && !/[ая]$/iu.test(part);
}

/** Часть дефисной фамилии, которую склонять нельзя: приставка либо восточный формант. */
function isIndeclinablePart(part: string): boolean {
  const p = part.toLowerCase();
  return INDECLINABLE_PARTS.has(p) || PATRONYMIC_MARKERS.some(([re]) => re.test(p));
}

/**
 * Склоняет ОДНУ фамилию (без имени и инициалов) в заданный падеж.
 *
 * Дефисные разбираются по частям и каждая склоняется по общим правилам — этот же принцип
 * даёт верный результат на всех трёх типах составных фамилий:
 *   Тер-Петросян → Тер-Петросяна (приставка неизменяема);
 *   Салтыков-Щедрин → Салтыкова-Щедрина (обе части самостоятельные);
 *   Немирович-Данченко → Немировича-Данченко (вторая на -о неизменяема).
 */
export function inflectSurname(surname: string, gramCase: GramCase, gender: Gender): string {
  if (!surname || gramCase === "nom") return surname;
  if (surname.includes("-")) {
    return surname
      .split("-")
      .map((part) => (isIndeclinablePart(part) ? part : inflectSurname(part, gramCase, gender)))
      .join("-");
  }
  if (isIndeclinablePart(surname) || isIndeclinableForGender(surname, gender)) return surname;
  try {
    return inclineLastname(surname, LVOVICH_CASE[gramCase], gender === "femn" ? "female" : "male")
      ?? surname;
  } catch {
    return surname; // fail-open: лучше именительный, чем испорченное слово
  }
}

/** Все шесть форм фамилии. Используется и для поиска склонённого суррогата в ответе модели. */
export function surnameForms(surname: string, gender: Gender): Map<GramCase, string> {
  const forms = new Map<GramCase, string>([["nom", surname]]);
  for (const gramCase of OBLIQUE_CASES) {
    forms.set(gramCase, inflectSurname(surname, gramCase, gender));
  }
  return forms;
}

/**
 * Склоняет ФИО целиком, меняя ТОЛЬКО фамилию: имя и отчество в наших поверхностях либо
 * заданы инициалами («Петров А.В.»), либо являются восточным формантом, который не склоняется.
 */
export function inflectFullName(value: string, gramCase: GramCase, gender?: Gender): string {
  const parsed = parseName(value);
  if (parsed.surnameIndex < 0) return value;
  const parts = [...parsed.parts];
  parts[parsed.surnameIndex] = inflectSurname(
    parsed.surname,
    gramCase,
    gender ?? parsed.gender ?? "masc",
  );
  return parts.join(" ");
}

/**
 * Все падежные написания ФИО. Нужны при возврате оригиналов: модель свободно склоняет
 * выданный ей суррогат («направлено Петрову А.В.»), и без этих форм поверхность не
 * находится — пользователь получает в тексте вымышленного человека вместо настоящего.
 */
export function fullNameForms(value: string, gender?: Gender): Array<[GramCase, string]> {
  const out: Array<[GramCase, string]> = [["nom", value]];
  for (const gramCase of OBLIQUE_CASES) {
    const form = inflectFullName(value, gramCase, gender);
    if (form !== value) out.push([gramCase, form]);
  }
  return out;
}

/** Отсечения, порождающие кандидатов в именительный падеж. Проверяются round-trip'ом. */
const LEMMA_CANDIDATES: ReadonlyArray<[RegExp, string]> = [
  [/(?:ого|его)$/iu, "ий"],
  [/(?:ому|ему)$/iu, "ий"],
  [/(?:ого|его)$/iu, "ой"],
  [/(?:ым|им|ом|ем|ём)$/iu, ""],
  // Женское прилагательное («Рутковской» → «Рутковская») — ВЫШЕ общего отсечения -ой→-а:
  // оно даёт «Рутковска», и round-trip его случайно подтверждает.
  [/(?<=.)кой$/iu, "кая"],
  [/(?:ой|ей|ою|ею)$/iu, "а"],
  [/(?:у|ю|е|и|ы|а|я)$/iu, ""],
  [/(?:у|е|и|ы)$/iu, "а"],
  [/(?:ю|и)$/iu, "я"],
  // Мягкий знак восстанавливаем ТОЛЬКО после согласной («Гоголя» → «Гоголь»). После гласной
  // это именительный на -ия/-оя («Данелия», «Гамсахурдия»), и отсечение его бы испортило.
  [/(?<=[бвгджзклмнпрстфхцчшщ])[яю]$/iu, "ь"],
  // ПРИЛАГАТЕЛЬНЫЕ ФАМИЛИИ на -ский/-цкий в творительном и предложном: «Миневским»,
  // «Миневском», плюс женский винительный «Рутковскую». Класс частый, а до этого он вообще
  // не сводился к именительному, и падежи одного человека расходились по разным токенам.
  //
  // ПОСЛЕДНИМИ — намеренно. Кандидаты проверяются round-trip'ом по порядку, и первый
  // подошедший выигрывает; поставленные раньше, эти отсечения перехватывали обычные -ов/-ев
  // («Ивановым» → «Ивановой» вместо «Иванов»), потому что склонение случайно сходилось.
  //
  // Только -к-, а не любое -ым/-им: правило на голое окончание ломает короткие фамилии
  // («Ким» → «Кий»). Лукбехайнд требует хотя бы одну букву перед формантом по той же причине.
  [/(?<=.)ким$/iu, "кий"],
  [/(?<=.)ком$/iu, "кий"],
  [/(?<=.)кую$/iu, "кая"],
];

/**
 * Приводит фамилию к именительному падежу.
 *
 * Проверка round-trip'ом, а не таблицей окончаний: кандидат принимается, только если
 * обратное склонение его же даёт ровно исходную форму. Поэтому «Глоба», «Кафка», «Гулиа»
 * (именительный, похожий на косвенный) остаются собой, а «Кимом» → «Ким».
 *
 * Зачем это нужно вообще: суррогат сеется от леммы. Без неё «Иванов» и «Иванову» —
 * два разных ключа, и один человек получает в документе два разных вымышленных имени.
 *
 * СОЗНАТЕЛЬНЫЙ КОМПРОМИСС. Форма на -а после согласной неоднозначна без контекста:
 * «Гончарука» — родительный от «Гончарук», а «Глоба» — именительный сам по себе. Мы
 * выбираем лемматизацию, потому что цена ошибок разная: посчитать именительный косвенным
 * → суррогат встанет не в том падеже (текст читается криво); посчитать косвенный
 * именительным → у одного человека будет ДВА разных вымышленных имени в одном документе,
 * то есть развалится связность, ради которой суррогаты и вводились.
 */
export function lemmatizeSurname(surface: string, gender: Gender): string {
  if (!surface) return surface;
  if (surface.includes("-")) {
    return surface
      .split("-")
      .map((part) => (isIndeclinablePart(part) ? part : lemmatizeSurname(part, gender)))
      .join("-");
  }

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const [pattern, replacement] of LEMMA_CANDIDATES) {
    if (!pattern.test(surface)) continue;
    const candidate = surface.replace(pattern, replacement);
    // Двухбуквенные основы отбрасываем: для коротких фамилий («Ли», «Ким») отсечение даёт
    // мусор, который round-trip иногда подтверждает случайным совпадением («Ли» ← «Ля»).
    if (candidate.length < 3 || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    for (const gramCase of OBLIQUE_CASES) {
      if (inflectSurname(candidate, gramCase, gender) === surface) return candidate;
    }
  }
  return surface;
}

/**
 * Падеж фамилии по её форме. Служит только для того, чтобы поставить суррогат в тот же
 * падеж, что и оригинал; ошибка здесь портит согласование, но не смысл, поэтому при любой
 * неоднозначности возвращаем именительный.
 *
 * Определяется тем же round-trip'ом: берём лемму и смотрим, какая её форма совпала.
 * Так покрываются и нерусские фамилии («Кимом» → ins, «Оганесяну» → dat), которых нет
 * ни в одном списке русских окончаний.
 */
export function inferSurnameCase(surface: string, gender: Gender): GramCase {
  const lemma = lemmatizeSurname(surface, gender);
  if (lemma === surface) return "nom";
  for (const gramCase of OBLIQUE_CASES) {
    if (inflectSurname(lemma, gramCase, gender) === surface) return gramCase;
  }
  return "nom";
}
