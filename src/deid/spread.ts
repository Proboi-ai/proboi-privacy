/**
 * Протяжка личности по документу.
 *
 * ЗАЧЕМ. Детектор работал попозиционно: нашёл человека в шапке договора — в теле документа
 * то же имя мог не увидеть. Независимая проверка на договорах ЕИС (29.07) показала ровно
 * это: канонические формы («Фамилия И.О.», «Фамилия Имя Отчество») закрываются на 97-100%,
 * а ОДИНОЧНОЕ ИМЯ («Алексей согласовал») — на 58-67%. Ни правила, ни модель одиночное имя
 * надёжно не берут и взять не могут: «Алексей» без контекста неотличим от чего угодно.
 *
 * ЧТО ДЕЛАЕМ. Контекст, которого не хватает, в документе УЖЕ ЕСТЬ — выше по тексту. Если в
 * шапке подтверждён «Гвоздев Алексей Петрович», то «Алексей» ниже — это он. Поэтому:
 * берём ПОДТВЕРЖДЁННЫЕ личности (только канонические формы — с отчеством или с инициалами),
 * раскладываем на части, склоняем каждую часть во все падежи и проходим документ целиком.
 *
 * ПОЧЕМУ ЭТО НЕ РОНЯЕТ ТОЧНОСТЬ. Протягиваются только части ПОДТВЕРЖДЁННОГО человека —
 * никаких новых кандидатов не изобретается. Плюс три ограничителя:
 *   • омонимы гасятся признаком «встречается строчными в этом же документе»: «Вера»,
 *     «Любовь», «Роман» как имена в договоре строчными не пишутся, а как слова — постоянно;
 *   • форма, которая принадлежит ДВУМ разным личностям (однофамильцы), не протягивается
 *     вовсе: молча приписать вхождение не тому человеку хуже, чем не заметить его;
 *   • короткие части (≤2 знаков) пропускаются — это инициалы и мусор.
 *
 * ЛИЧНОСТЬ ОДНА. Протянутые вхождения несут `identity` родителя, поэтому «Алексей» и
 * «Гвоздев Алексей Петрович» получают ОДИН ярлык. Иначе модель видела бы двух разных
 * людей — та самая связность, ради которой обезличивание делают обратимым.
 */

import { inclineFirstname, inclineMiddlename } from "lvovich";
import type { DetectedEntity } from "./detect";
import { isFalsePositivePerson } from "./precision";
import { createLocalMorphAdapter } from "./morph";
import {
  inflectSurname,
  lemmatizeSurname,
  OBLIQUE_CASES,
  type GramCase,
  type Gender,
} from "./surname";

/** Инициал: «И.», «И.О.», «ИИ» — в разбор личности как слово не идёт. */
const INITIAL = /^(?:[А-ЯЁA-Z]\.){1,3}$|^[А-ЯЁA-Z]{1,3}\.?$/u;

/**
 * Отчество по суффиксу — ВО ВСЕХ ПАДЕЖАХ. Тот же признак, что и в правилах: -вич/-вна/-ична
 * больше нигде не встречается. Падежные окончания обязательны: в шапке договора стороны
 * представляются в родительном («в лице Гвоздева Алексея Петровича»), и правило на
 * именительный не опознавало там человека вовсе — то есть протягивать было нечего.
 */
const PATRONYMIC = /(?:вич(?:ем|а|у|е)?|вн(?:а|ы|е|у|ой|ою)|ичн(?:а|ы|е|у|ой|ою))$/u;

/**
 * Именительный падеж части имени, подобранный ОБРАТНЫМ СКЛОНЕНИЕМ.
 *
 * Словаря имён у нас нет и быть не должно, зато есть склонятель. Поэтому идём от него:
 * порождаем кандидатов отсечением окончания, склоняем каждого во все падежи и берём того,
 * чья форма буква в букву совпала с наблюдённой. Тот же приём, что в `lemmatizeSurname`, —
 * он не выдумывает слов и на неудаче честно возвращает исходное написание.
 */
function lemmatize(
  word: string,
  gender: Gender,
  inflect: (candidate: string, gramCase: GramCase) => string,
): string {
  // Порядок хвостов значим, и он РАЗНЫЙ по роду. Обратная проверка подтверждает первого
  // подошедшего кандидата, а подходят несколько: у «Алексея» это и мусорное «Алексе»
  // (пустой хвост), и верное «Алексей»; у «Ольги» — и «Ольгь», и верное «Ольга». Поэтому
  // сначала пробуем окончание, типичное для именительного в этом роде.
  const tails = gender === "femn" ? ["а", "я", "ь", "й", "е", "о", ""] : ["й", "", "ь", "а", "я", "о", "е"];
  const candidates = new Set<string>();
  for (let cut = 1; cut <= 3 && cut < word.length - 1; cut++) {
    const stem = word.slice(0, -cut);
    for (const tail of tails) candidates.add(stem + tail);
  }
  for (const candidate of candidates) {
    if (candidate.length < 3 || candidate === word) continue;
    // Фонотактика русского отсеивает невозможные основы раньше, чем их успеет подтвердить
    // случайное совпадение при обратном склонении: «й» и «ь» после согласной/гласной
    // соответственно не встречаются, а «Игорй» и «Ольгь» именно так и рождались.
    if (/(?<![аеёиоуыэюя])й$/u.test(candidate) || /(?<=[аеёиоуыэюя])ь$/u.test(candidate)) continue;
    for (const gramCase of OBLIQUE_CASES) {
      if (inflect(candidate, gramCase) === word) return candidate;
    }
  }
  return word;
}

/** Восточный формант отчества — не склоняется и частью имени не считается. */
const MARKER = /^(?:оглы|оглу|огли|улы|уулу|углы|кызы|гызы|кизи|кыз)$/u;

const LVOVICH_CASE = {
  gen: "genitive",
  dat: "dative",
  acc: "accusative",
  ins: "instrumental",
  loc: "prepositional",
} as const;

const MORPH = createLocalMorphAdapter();

/** Разложенная личность: что протягивать и в каком роде. */
interface Identity {
  /** Ключ сейфа — тот же, что посчитает морфология для родительской находки. */
  key: string;
  gender: Gender;
  /** Части, годные к протяжке: фамилия, имя, отчество. Инициалы и форманты сюда не попадают. */
  surname?: string;
  given?: string;
  patronymic?: string;
}

/**
 * Разбирает находку на части — но ТОЛЬКО если это каноническая форма, то есть человек
 * подтверждён самой формой записи: есть отчество либо есть инициалы. «Иван Петров» без
 * отчества и без инициалов сюда не проходит: пары заглавных слов в договоре сколько угодно
 * («Общие Условия», «Приложение Один»), и протягивать их по документу нельзя.
 */
function parseIdentity(raw: string): Identity | null {
  const parts = raw.trim().split(/\s+/u).filter(Boolean);
  if (parts.length < 2) return null;

  const words: string[] = [];
  let hasInitial = false;
  for (const part of parts) {
    if (MARKER.test(part.toLowerCase())) continue;
    if (INITIAL.test(part)) {
      hasInitial = true;
      continue;
    }
    words.push(part);
  }

  const patronymicAt = words.findIndex((w) => PATRONYMIC.test(w));
  if (patronymicAt < 0 && !hasInitial) return null;

  const analysis = MORPH.analyze(raw, "PER");
  if (!analysis) return null;
  const gender: Gender = analysis.form.gender === "femn" ? "femn" : "masc";
  const identity: Identity = { key: analysis.lemma, gender };

  if (patronymicAt >= 0) {
    identity.patronymic = words[patronymicAt];
    // Русский порядок: «Фамилия Имя Отчество» либо «Имя Отчество Фамилия». Имя — всегда
    // слово ПЕРЕД отчеством; фамилия — оставшееся третье, если оно есть.
    const rest = words.filter((_, i) => i !== patronymicAt);
    if (patronymicAt >= 1) identity.given = words[patronymicAt - 1];
    const surname = rest.find((w) => w !== identity.given);
    if (surname !== undefined) identity.surname = surname;
  } else {
    // Инициалы: единственное полное слово — фамилия («Иванов И.П.», «И.П. Иванов»).
    identity.surname = words[0];
  }
  return identity;
}

/** Склонятель под вид части имени. Падает — отдаём исходное написание (fail-open). */
function inflectorFor(
  kind: "surname" | "given" | "patronymic",
  gender: Gender,
): (word: string, gramCase: GramCase) => string {
  return (word, gramCase) => {
    if (gramCase === "nom") return word;
    try {
      if (kind === "surname") return inflectSurname(word, gramCase, gender);
      const incline = kind === "given" ? inclineFirstname : inclineMiddlename;
      return incline(word, LVOVICH_CASE[gramCase], gender === "femn" ? "female" : "male") ?? word;
    } catch {
      return word;
    }
  };
}

/**
 * Все падежные написания одной части имени.
 *
 * Наблюдённая форма сначала приводится к именительному: в шапке договора человек стоит в
 * родительном («Алексея Владимировича»), и склонять эту форму дальше — значит породить
 * несуществующие слова и не найти в тексте ни одного настоящего вхождения.
 */
function formsOf(word: string, kind: "surname" | "given" | "patronymic", gender: Gender): string[] {
  const inflect = inflectorFor(kind, gender);
  const nominative =
    kind === "surname" ? lemmatizeSurname(word, gender) : lemmatize(word, gender, inflect);
  const out = new Set<string>([nominative, word]);
  for (const gramCase of OBLIQUE_CASES) {
    const form = inflect(nominative, gramCase);
    if (form) out.add(form);
  }
  return [...out];
}

/** Слова, встреченные в документе со СТРОЧНОЙ буквы (в нижнем регистре, для сравнения). */
function lowercaseWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[а-яё][а-яё-]{2,}/gu)) out.add(m[0]);
  return out;
}

/** Буква, продолжающая слово. В JS `\b` работает по ASCII и на кириллице врёт. */
const WORD_CHAR = /[А-Яа-яЁё-]/u;

/**
 * Все вхождения строки как отдельного слова. Через `indexOf`, а не через RegExp: протяжка
 * ищет сотни значений в документе на сотню килобайт, и компиляция регулярки на каждое
 * значение сама по себе стоила дороже поиска.
 */
function occurrencesOf(text: string, form: string): number[] {
  const out: number[] = [];
  for (let from = text.indexOf(form); from >= 0; from = text.indexOf(form, from + 1)) {
    const before = text[from - 1];
    const after = text[from + form.length];
    if (before !== undefined && WORD_CHAR.test(before)) continue;
    if (after !== undefined && WORD_CHAR.test(after)) continue;
    out.push(from);
  }
  return out;
}

/**
 * Добавляет к найденным сущностям вхождения частей ПОДТВЕРЖДЁННЫХ личностей по всему тексту.
 *
 * Возвращает ТОЛЬКО добавленное — перекрытия снимает вызывающий через `resolveOverlaps`,
 * там же протянутое вхождение уступает более длинной находке («Иванов» внутри «Иванов И.П.»).
 */
export function spreadIdentities(text: string, ents: readonly DetectedEntity[]): DetectedEntity[] {
  const identities: Identity[] = [];
  for (const e of ents) {
    if (e.type !== "PER") continue;
    const parsed = parseIdentity(e.raw);
    if (parsed && !identities.some((i) => i.key === parsed.key)) identities.push(parsed);
  }
  if (identities.length === 0) return [];

  const lower = lowercaseWords(text);

  // Форма → чья она. Форма, доставшаяся двум личностям (однофамильцы, тёзки), выбывает:
  // угадывать, кто именно имелся в виду, мы не будем.
  const owner = new Map<string, string | null>();
  for (const identity of identities) {
    const parts: Array<[string, "surname" | "given" | "patronymic"]> = [];
    if (identity.surname) parts.push([identity.surname, "surname"]);
    if (identity.given) parts.push([identity.given, "given"]);
    if (identity.patronymic) parts.push([identity.patronymic, "patronymic"]);

    for (const [word, kind] of parts) {
      if (word.length <= 2) continue;
      const forms = formsOf(word, kind, identity.gender);
      // Омоним: часть имени встречается в этом же документе строчными («вера», «роман»,
      // «мороз»). Тогда протяжка молча спрятала бы обычные слова — не протягиваем вовсе.
      if (forms.some((f) => lower.has(f.toLowerCase()))) continue;
      for (const form of forms) {
        owner.set(form, owner.has(form) && owner.get(form) !== identity.key ? null : identity.key);
      }
    }
  }

  const added: DetectedEntity[] = [];
  for (const [form, key] of owner) {
    if (key === null) continue;
    for (const index of occurrencesOf(text, form)) {
      added.push({
        type: "PER",
        raw: form,
        index,
        confidence: "medium",
        source: "rule",
        identity: key,
      });
    }
  }
  return added;
}

/**
 * Протяжка ПОВЕРХНОСТИ: значение, скрытое в одном месте, скрывается везде, где встречается
 * ровно так же.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ ПАДЕЖНОЙ ПРОТЯЖКИ. Детекторы контекстные: правило ORG требует рядом
 * кавычки-название, правило CASE — слово «дело», модель смотрит на окружение. Поэтому одна и
 * та же организация закрывается в шапке и остаётся открытой в пункте 7.2 — на замере 29.07
 * это давало 663 несогласованных вхождения у конфигурации с Natasha, из них 98 остатков ORG
 * после падежной протяжки. Морфология тут не нужна: совпадение дословное.
 *
 * ЧЕГО НЕ ДЕЛАЕМ. Не протягиваем ФИО, не прошедшие фильтр точности: если «Заказчик» ошибочно
 * принят за человека, протяжка размножит ошибку на весь документ и модель получит текст, из
 * которого вынуто обычное слово. Ошибку лучше оставить одиночной.
 */
export function spreadSurfaces(text: string, ents: readonly DetectedEntity[]): DetectedEntity[] {
  const seen = new Map<string, DetectedEntity>();
  for (const e of ents) {
    if (e.raw.trim().length < 3) continue;
    if (e.type === "PER" && isFalsePositivePerson(e.raw, text, e.index)) continue;
    if (!seen.has(`${e.type}\0${e.raw}`)) seen.set(`${e.type}\0${e.raw}`, e);
  }

  const taken = new Set(ents.map((e) => `${e.index}\0${e.raw.length}`));
  const added: DetectedEntity[] = [];
  for (const source of seen.values()) {
    for (const index of occurrencesOf(text, source.raw)) {
      if (taken.has(`${index}\0${source.raw.length}`)) continue;
      added.push({ ...source, index });
    }
  }
  return added;
}
