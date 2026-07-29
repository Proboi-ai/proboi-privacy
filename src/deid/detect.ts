/**
 * Де-ид текста — УРОВЕНЬ ПО УМОЛЧАНИЮ (ts-spine, без Python).
 *
 * Доменный словарь орг-форм + regex ФИО/дат/№дел. Покрывает ~80% за ~0 деп
 * (council). Высокий recall (~95% F1) = опц. Natasha-сайдкар, fallback
 * поверх этого слоя. Честное ограничение: часть PII может протечь →
 * человек-в-цикле, не слепое доверие.
 *
 * Типы определены в entities.ts; regex/checksum-слой здесь, NER и координаты подключаются
 * через существующие sidecar/geo-компоненты.
 * confidence: 'high' — специфичный паттерн/словарь; 'medium' — эвристика по форме.
 *
 * Паспорт/ИНН/телефон: keyword-gated правила (см. PASSPORT/INN ниже) + PHONE по формату
 * РФ. Адрес сознательно НЕ добавлен regex-детектором — сформулировать его без массы
 * ложных срабатываний (любая строка «слово + цифра») regex-ом не выйдет; честный путь —
 * Natasha-сайдкар.
 */

import { detectCoords } from "../geo/coords";
import {
  isValidAccount,
  isValidBik,
  isValidCard,
  isValidOgrn,
  isValidOgrnip,
  isValidSnils,
} from "./checksums";
import type { EntityType } from "./entities";

export type { EntityType } from "./entities";

export interface DetectedEntity {
  type: EntityType;
  raw: string;
  index: number;
  confidence: "high" | "medium";
  source?: "rule" | "ner";
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

/**
 * Фамилия: слово с заглавной, при необходимости составное через дефис.
 * Дефис обязателен — без него правила не видят «Тер-Петросян А.Б.», «Мамед-заде И.О.»,
 * «Сухово-Кобылин В.А.», а это ровно те фамилии, ради которых слой и переделывался.
 */
const SURNAME = "[А-ЯЁ][а-яё]+(?:[-‑][А-ЯЁ]?[а-яё]+){0,2}";

/**
 * Восточные форманты отчества. Однозначный признак ФИО: «Алиев Гейдар Али оглы».
 * Список тот же, что в surname.ts — там он используется для определения пола.
 */
const PATRONYMIC_MARKER = "оглы|оглу|огли|улы|уулу|углы|кызы|гызы|кизи";

/**
 * Слова-рубрикаторы: после них одиночная буква с точкой — нумерация раздела, а не инициал.
 * Без этого «Приложение А.» и «Таблица Б.» уезжали бы в токены как люди.
 */
const RUBRIC_WORDS = new Set([
  "приложение", "приложения", "таблица", "таблицы", "табл", "рисунок", "рис", "схема",
  "глава", "раздел", "пункт", "часть", "том", "книга", "лист", "чертеж", "чертёж",
  "карта", "проба", "образец", "интервал", "форма", "вариант", "серия", "группа",
  "класс", "тип", "категория", "приказ", "письмо", "акт", "протокол", "версия",
  "объект", "участок", "скважина", "профиль", "маршрут", "этап", "стадия", "фонд",
]);

interface Rule {
  type: EntityType;
  re: RegExp;
  confidence: "high" | "medium";
  validate?: (raw: string, text: string) => boolean;
}

const RULES: Rule[] = [
  // ORG: форма + «Название» (кавычки-ёлочки или прямые)
  {
    type: "ORG",
    re: new RegExp(
      `(?:${ORG_FORMS.join("|")})\\s+[«"][^»"]+[»"](?:\\s+им\\.\\s+[А-ЯЁ]\\.[А-ЯЁ]\\.\\s+[А-ЯЁ][а-яё-]+)?`,
      "gu",
    ),
    confidence: "high",
  },
  {
    type: "ORG",
    re: /(?:обществ[ао]|компани[яи]|организаци[яи]|учреждени[ея])\s+[«"][^»"]+[»"]/giu,
    confidence: "high",
  },
  // CASE: арбитражное дело А40-12345/2020, 40-12345/2020 или 2а–123/2020.
  // Не используем универсальное «№…»: оно ошибочно забирает номера договоров.
  { type: "CASE", re: /(?<![А-ЯЁа-яёA-Za-z0-9])А?\d{1,2}[а-я]?[-–]\d{2,6}\/\d{4}(?!\d)/giu, confidence: "high" },
  // Короткий внутренний формат только после явного слова «дело».
  { type: "CASE", re: /(?<=дело\s)№\s*\d{1,3}[-–]\d{1,6}(?![\d/])/giu, confidence: "high" },
  // Форматы карточек Верховного Суда: 18-КГ26-41-К4, 5-АД26-12-К2, АКПИ26-262.
  {
    type: "CASE",
    re: /(?<![А-ЯЁа-яёA-Za-z0-9])(?:\d{1,2}[-–][А-ЯЁ]{2}\d{2}[-–]\d{1,4}[-–][А-ЯЁ]\d|АКПИ\d{2}[-–]\d{1,6})(?![А-ЯЁа-яёA-Za-z0-9])/gu,
    confidence: "high",
  },
  // PASSPORT: серия (4 цифры) + номер (6 цифр) РЯДОМ со словом «паспорт» — keyword-gated,
  // чтобы не путать со случайной 10-значной последовательностью. Матч целиком
  // (включая слово) уходит в токен — как и CASE-правило выше с «№».
  {
    type: "PASSPORT",
    re: /паспорт[а-яё]*[:\s]+(?:[а-яё]+[:\s]+){0,3}(?:сери[яи]\s*)?№?\s*\d{2}\s?\d{2}\s*(?:№\s?|номер\s?)?\d{6}\b/giu,
    confidence: "high",
  },
  // ИНН: явный keyword gate достаточен. Даже ошибочно набранный ИНН остаётся приватным
  // значением и маскируется; checksum-валидатор используется отдельно и при генерации суррогатов.
  {
    type: "INN",
    re: /ИНН[:\s]*(?:\d{12}|\d{10})\b/giu,
    confidence: "high",
  },
  // PHONE: РФ-формат +7/8 + 10 цифр в типовой группировке (пробел/тире/скобки опционально).
  {
    type: "PHONE",
    re: /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}\b/gu,
    confidence: "high",
  },
  {
    type: "EMAIL",
    re: /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/giu,
    confidence: "high",
  },
  {
    type: "ADDR",
    re: /(?<!\d)\d{6}\s+[А-ЯЁ][А-ЯЁ -]+,\s*УЛ\.\s*[А-ЯЁ .-]+,\s*\d+(?:\/\d+)?(?:,\s*[А-ЯЁ0-9-]+)?/gu,
    confidence: "high",
  },
  {
    type: "ADDR",
    re: /г\.\s*[А-ЯЁ][а-яё]+,\s*ул\.\s*[А-ЯЁ][а-яё]+,\s*д\.\s*\d+(?:\/\d+)?/gu,
    confidence: "high",
  },
  {
    type: "URL",
    re: /\bhttps?:\/\/[^\s<>"'«»]+/giu,
    confidence: "high",
  },
  {
    type: "IP",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
    confidence: "high",
    validate: (raw) => raw.split(".").every((part) => Number(part) <= 255),
  },
  {
    type: "LICENSE_SUBSOIL",
    re: /(?<![А-ЯЁа-яё])[А-ЯЁ]{3}\s?\d{5,6}\s?[А-ЯЁ]{2}(?![А-ЯЁа-яё])/gu,
    confidence: "medium",
  },
  {
    type: "WELL",
    re: /(?:[а-яё]+\s+)?(?:скважин[а-яё]*|скв\.?|буров(?:ая|ой|ую))\s*[:.]?\s*№?\s*[А-Яа-яA-Za-z0-9][А-Яа-яA-Za-z0-9./-]*/giu,
    confidence: "medium",
  },
  {
    type: "FIELD",
    re: /(?:уч(?:асток)?\.?|участк[а-яё]*|площадь)(?:\s+недр)?\s*[«"][^»"]+[»"]/giu,
    confidence: "medium",
  },
  {
    type: "FIELD",
    re: /(?:[«"])?р\.\s*[А-ЯЁ][А-ЯЁа-яё-]+(?:,\s*приток\s+реки\s+[А-ЯЁ][А-ЯЁа-яё-]+)?(?:[»"])?/gu,
    confidence: "medium",
  },
  {
    type: "FIELD",
    re: /объект\s*(?:—|–|-|:)?\s*(?:м-е\s+)?[А-ЯЁ][А-ЯЁа-яё.-]+(?=\s*(?:[;/]|$))/gu,
    confidence: "medium",
  },
  {
    type: "FIELD",
    re: /(?<![А-ЯЁа-яё])[А-ЯЁ][А-ЯЁа-яё-]+(?:\s+(?:част[а-яё]*|участк[а-яё]+|[А-ЯЁ][А-ЯЁа-яё-]+)){0,3}\s+(?:участк[а-яё]+|месторождени[а-яё]*)(?![А-ЯЁа-яё])/gu,
    confidence: "medium",
  },
  {
    type: "CADASTRE",
    re: /\b\d{2}:\d{2}:(?:\d{6,7}|\d{4}:\d{3}):\d{1,7}\b/gu,
    confidence: "medium",
  },
  {
    type: "OGRNIP",
    re: /ОГРНИП[:\s]*\d{15}\b/giu,
    confidence: "high",
    validate: (raw) => isValidOgrnip(raw.replace(/\D/g, "")),
  },
  {
    type: "OGRN",
    re: /ОГРН(?!ИП)[:\s]*\d{13}\b/giu,
    confidence: "high",
    validate: (raw) => isValidOgrn(raw.replace(/\D/g, "")),
  },
  { type: "KPP", re: /КПП[:\s]*\d{9}\b/giu, confidence: "medium" },
  {
    type: "CONTRACT_NO",
    re: /(?:договор[а-яё]*|контракт[а-яё]*|соглашени[а-яё]*|дог-р)(?:\s+(?!от\b)[а-яё-]+){0,3}(?:\s+от\s+\d{1,2}\.\d{1,2}\.\d{4})?\s*№\s*[А-Яа-яA-Za-z0-9][А-Яа-яA-Za-z0-9./-]*/giu,
    confidence: "high",
  },
  {
    type: "NOTARY_REG",
    re: /(?<!\d)\d{2}\/\d{3,6}-н\/\d{2}-\d{4}-\d{1,3}-\d{1,3}(?!\d)/giu,
    confidence: "high",
  },
  {
    type: "NOTARY_REG",
    re: /реестр(?:овый|ового)?\.?\s*(?:номер|№)\s*[А-Яа-яA-Za-z0-9][А-Яа-яA-Za-z0-9./-]*/giu,
    confidence: "medium",
  },
  {
    type: "BIK",
    re: /БИК[:\s]*\d{9}\b/giu,
    confidence: "high",
    validate: (raw) => isValidBik(raw.replace(/\D/g, "")),
  },
  {
    type: "ACCOUNT",
    re: /(?:расч[её]тн(?:ый|ого)|корреспондентск(?:ий|ого)|лицев(?:ой|ого))\s+сч[её]т[:\s№]*\d{20}\b/giu,
    confidence: "high",
    // ponytail: один БИК на документ; связывать по ближайшему, если появятся multi-bank документы.
    validate: (raw, text) => {
      const account = raw.replace(/\D/g, "").slice(-20);
      const bik = /БИК[:\s]*(\d{9})\b/iu.exec(text)?.[1];
      return bik !== undefined && isValidAccount(account, bik);
    },
  },
  {
    type: "CARD",
    re: /(?:карт[аы]|PAN)[:\s№]*(?:\d[ -]?){12,18}\d\b/giu,
    confidence: "high",
    validate: (raw) => isValidCard(raw.replace(/\D/g, "")),
  },
  {
    type: "AMOUNT",
    re: /\b\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{2})?\s*(?:₽|руб(?:\.|лей|ля)?)(?![А-Яа-яЁё])/giu,
    confidence: "high",
  },
  {
    type: "SNILS",
    re: /СНИЛС[:\s]*(?:\d{3}[ -]?){2}\d{3}[ -]?\d{2}\b/giu,
    confidence: "high",
    validate: (raw) => isValidSnils(raw.replace(/[^\d -]/g, "")),
  },
  {
    type: "POLICY_OMS",
    re: /(?:полис(?:а)?\s+ОМС|ОМС)[:\s№]*\d{16}\b/giu,
    confidence: "medium",
  },
  {
    type: "MRN",
    re: /(?:медицинск[а-яё]+\s+карт[а-яё]*|медкарт[а-яё]*)[:\s№]*[А-Яа-яA-Za-z0-9][А-Яа-яA-Za-z0-9/-]*/giu,
    confidence: "medium",
  },
  {
    type: "ICD",
    re: /(?:МКБ(?:-10)?|диагноз)[:\s]*[A-ZА-Я]\d{2}(?:\.\d{1,2})?\b/giu,
    confidence: "high",
  },
  {
    type: "PERSONNEL_NO",
    re: /табельн[а-яё]*\s+(?:номер|№)[:\s]*[А-Яа-яA-Za-z0-9][А-Яа-яA-Za-z0-9/-]*/giu,
    confidence: "medium",
  },
  {
    type: "LABOUR_BOOK",
    re: /трудов[а-яё]*\s+книжк[а-яё]*[:\s]*(?:серия\s*)?[А-ЯA-Z0-9-]+\s*№?\s*\d{6,7}\b/giu,
    confidence: "medium",
  },
  {
    type: "DL",
    re: /водительск[а-яё]*\s+удостоверени[а-яё]*[:\s№]*(?:\d{2}\s?\d{2}\s?\d{6})\b/giu,
    confidence: "medium",
  },
  {
    type: "PLATE",
    re: /(?<![А-ЯЁA-Z0-9])[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}(?![А-ЯЁA-Z0-9])/gu,
    confidence: "high",
  },
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
  // PER: Фамилия И.О. / Фамилия И. О. / Фамилия И.И (вторая точка теряется в таблицах)
  // (?<!…)/(?!…) вместо \b — в JS \b работает по ASCII \w и с кириллицей ломается.
  {
    type: "PER",
    // Два хвостовых условия. С точкой — следом не должно быть фамилии (иначе это форма
    // «И.О. Фамилия», и матч «Утвердил А.С» откусил бы у неё инициалы). Без точки —
    // следом не должно быть ни точки, ни буквы: «Иванов И.С» в конце ячейки таблицы.
    re: new RegExp(
      `(?<![А-Яа-яЁё])${SURNAME}\\s+[А-ЯЁ]\\.\\s?[А-ЯЁ](?:\\.(?!\\s?[А-ЯЁ][а-яё])|(?![.А-Яа-яЁёA-Za-z]))`,
      "gu",
    ),
    confidence: "high",
  },
  // PER: И.О. Фамилия
  {
    type: "PER",
    re: new RegExp(`(?<![А-Яа-яЁё])[А-ЯЁ]\\.\\s?[А-ЯЁ]\\.\\s?${SURNAME}(?![а-яё])`, "gu"),
    confidence: "high",
  },
  // PER: Фамилия Имя Отчество (отчество -вич/-вна/-ична)
  {
    type: "PER",
    re: new RegExp(
      `(?<![А-Яа-яЁё])${SURNAME}\\s+[А-ЯЁ][а-яё]+\\s+[А-ЯЁ][а-яё]+(?:вич|вна|ична)(?![а-яё])`,
      "gu",
    ),
    confidence: "medium",
  },
  // PER: Фамилия Имя Отчество оглы/кызы — формант однозначен, поэтому high.
  {
    type: "PER",
    re: new RegExp(
      `(?<![А-Яа-яЁё])${SURNAME}\\s+[А-ЯЁ][а-яё]+\\s+[А-ЯЁ][а-яё]+\\s+(?:${PATRONYMIC_MARKER})(?![а-яё])`,
      "giu",
    ),
    confidence: "high",
  },
  // PER: Фамилия И. — один инициал. В подписях и списках исполнителей встречается наравне
  // с двумя, но форма опасна: «Приложение А.» выглядит так же. Отсюда medium и явный
  // фильтр рубрикаторов — по слову ПЕРЕД инициалом, а не по инициалу.
  {
    type: "PER",
    re: new RegExp(`(?<![А-Яа-яЁё])${SURNAME}\\s+[А-ЯЁ]\\.(?!\\s?[А-ЯЁ])`, "gu"),
    confidence: "medium",
    validate: (raw) => {
      const head = raw.split(/\s+/u)[0]!.toLowerCase();
      return !RUBRIC_WORDS.has(head);
    },
  },
];

const CONF_RANK = { high: 0, medium: 1 } as const;
const SOURCE_RANK = { rule: 0, ner: 1 } as const;

/**
 * Снимает перекрытия: точные правила приоритетнее NER, затем уверенность и длина.
 * Это не даёт широкому вероятностному спану затереть точный номер/идентификатор.
 */
export function resolveOverlaps(entities: DetectedEntity[]): DetectedEntity[] {
  const sorted = [...entities].sort(
    (a, b) =>
      SOURCE_RANK[a.source ?? "ner"] - SOURCE_RANK[b.source ?? "ner"] ||
      CONF_RANK[a.confidence] - CONF_RANK[b.confidence] ||
      b.raw.length - a.raw.length ||
      a.index - b.index,
  );
  const out: DetectedEntity[] = [];
  for (const e of sorted) {
    const end = e.index + e.raw.length;
    if (out.some((kept) => e.index < kept.index + kept.raw.length && kept.index < end)) continue;
    out.push(e);
  }
  return out.sort((a, b) => a.index - b.index);
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
      if (rule.validate && !rule.validate(m[0], text)) continue;
      found.push({ type: rule.type, raw: m[0], index: m.index!, confidence: rule.confidence, source: "rule" });
    }
  }
  // COORD не regex-правило detect.ts — делегируем в специализированный geo/coords
  // (DMS/десятичные градусы/полушария + валидация диапазона lat±90/lon±180). Координата =
  // PII (решение владельца) → токенизируем ДО облака наравне с ФИО/ORG.
  if (types.includes("COORD")) {
    for (const c of detectCoords(text)) {
      found.push({ type: "COORD", raw: c.raw, index: c.index, confidence: "high", source: "rule" });
    }
  }
  return resolveOverlaps(found);
}
