/**
 * Детекция географических координат в тексте (ts-spine, без сайдкара).
 *
 * Два независимых семейства, оба высокоточные (мало ложных срабатываний):
 *   • WGS84 — явные координатные пары (с °/N/E/С/В маркерами либо ≥3 знаков
 *     после запятой);
 *   • SK-42 (метровая проекционная, «Система координат 1942 года») — явные
 *     подписи X=/Y= (кириллица-омоглиф Х=/У= тоже — обычное дело в РФ-доках)
 *     либо голая пара 6–8-значных чисел РЯДОМ с явным маркером «СК-42»/
 *     «МСК-NN»/«Пулково-1942». Без якоря (подписи или маркера) метровые числа
 *     НЕ детектим — неотличимы от цены/номера договора/ИНН (тот же приём,
 *     что у LICENSE_SUBSOIL/GEO_NAME в deid/detect.ts: medium-confidence сущность
 *     требует соседнего слова-метки, а не голого числового паттерна).
 *
 * Координата — это PII (решение владельца, council): детектор нужен, чтобы
 * токенизировать её ДО облака. Числовая интерпретация (lat/lon для WGS84,
 * x/y для SK-42) — для «местной СК» (transform.ts) и прочих потребителей;
 * для самой токенизации хватает raw-подстроки, поэтому оба набора полей
 * необязательны.
 */

export interface GeoPoint {
  lat: number; // WGS84 широта, градусы
  lon: number; // WGS84 долгота, градусы
}

export type CoordSystem = "WGS84" | "SK-42";

export interface DetectedCoord {
  raw: string; // исходная подстрока (её и заменяем на токен — round-trip точный)
  index: number; // позиция в тексте
  system: CoordSystem;
  // WGS84: широта/долгота, градусы.
  lat?: number;
  lon?: number;
  // SK-42: абсцисса (X, север) / ордината (Y, восток), метры. Датум-конверсию
  // в WGS84 намеренно не считаем — нужна зона Гаусса-Крюгера, вне зоны этого
  // детектора; для токенизации она и не нужна (см. комментарий вверху файла).
  x?: number;
  y?: number;
}

// Полушария: широта (N/S/С/Ю), долгота (E/W/В/З), оба регистра
const HEMI = "NSEWnsewСЮВЗсювз";
const H_LAT = "NSnsСЮсю";
const H_NEG = "SWswЮЗюз"; // южное/западное → отрицательный знак

// Русские полушария пишут НЕ одной буквой, а сокращением с точками: «56°30'с.ш.
// 108°45'в.д.» — это доминирующая форма в геологических отчётах (замер на реальных
// отчётах EC 2026-08-01: 129 таких пар в выборке из 113 документов, все пропускались).
// Точка после буквы рвала разделитель пары `\s*[,;]?\s+`, поэтому вторая половина
// координаты никогда не подхватывалась и пара не складывалась.
const HEMI_RU_SRC = `(?:[СЮсю]\\s*\\.\\s*ш\\s*\\.|[ВЗвз]\\s*\\.\\s*д\\s*\\.)`;
/**
 * Суффикс полушария: сокращение с точками ЛИБО одна буква.
 * Одиночная буква обязана стоять отдельным словом: без этого «108°45' снят» съедало
 * «с» от «снят» как «северную широту», подменяло оси и пара отбрасывалась по
 * диапазону (|108.75| > 90). В русском тексте после координаты слово на с/в/ю/з —
 * обычное дело, так что это тихо резало полноту.
 */
const HEMI_SUF_SRC = `(?:${HEMI_RU_SRC}|[${HEMI}](?![А-Яа-яЁёA-Za-z]))?`;
const HEMI_TAIL_RE = new RegExp(`(?:${HEMI_RU_SRC}|[${HEMI}])\\s*$`, "u");

// Компонент координаты: DMS (град°мин'сек") либо десятичные градусы
const DMS_SRC = `\\d{1,3}\\s*°\\s*\\d{1,2}\\s*['′]\\s*(?:\\d{1,2}(?:[.,]\\d+)?\\s*["″])?\\s*${HEMI_SUF_SRC}`;
const DEC_SRC = `[+-]?\\d{1,3}[.,]\\d{3,}\\s*°?\\s*${HEMI_SUF_SRC}`;
const COMP_SRC = `(?:${DMS_SRC}|${DEC_SRC})`;
const PAIR_RE = new RegExp(`${COMP_SRC}\\s*[,;]?\\s+${COMP_SRC}`, "gu");
const COMP_RE = new RegExp(COMP_SRC, "gu");

// ── Якорь для ГОЛОЙ десятичной пары ─────────────────────────────────────────
// Пара вида «0,123 4,567» без градуса и без полушария неотличима от двух соседних
// чисел в таблице анализов — а таких в геологическом отчёте тысячи. Замер на реальных
// отчётах: 635 из 673 находок COORD (94%) были именно такими табличными числами.
// Поэтому голая пара принимается только если (а) у обеих компонент ≥4 знаков после
// запятой (точность градуса ~10 м — так пишут координаты, а не содержания), либо
// (б) рядом стоит слово-маркер. Это тот же приём, что уже применён к СК-42 ниже.
const COORD_MARKER_RE =
  /(?<![A-Za-zА-Яа-яЁё0-9])(?:координат[а-яё]*|широт[а-яё]*|долгот[а-яё]*|WGS[-\s]?84|latitude|longitude)(?![A-Za-zА-Яа-яЁё0-9])/iu;
const COORD_MARKER_WINDOW = 100;
const DEC_COMP_RE = /[+-]?\d{1,3}[.,]\d+/gu;
const BARE_DEC_MIN_FRACTION = 4;

/** Парсит одну компоненту → { value, axis } (axis: 'lat'|'lon'|null по полушарию). */
function parseComponent(s: string): { value: number; axis: "lat" | "lon" | null } | null {
  const hemiMatch = s.match(HEMI_TAIL_RE);
  // У сокращения «с.ш.»/«в.д.» смысл несёт первая буква — она же и в однобуквенной форме.
  const hemi = hemiMatch ? hemiMatch[0].trim()[0]! : null;
  const axis: "lat" | "lon" | null = hemi ? (H_LAT.includes(hemi) ? "lat" : "lon") : null;
  const sign = hemi && H_NEG.includes(hemi) ? -1 : 1;

  const dms = s.match(/(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*["″])?/u);
  let magnitude: number;
  if (dms) {
    const deg = parseInt(dms[1]!, 10);
    const min = parseInt(dms[2]!, 10);
    const sec = dms[3] ? parseFloat(dms[3].replace(",", ".")) : 0;
    magnitude = deg + min / 60 + sec / 3600;
  } else {
    const num = s.match(/[+-]?\d{1,3}[.,]\d+/u);
    if (!num) return null;
    magnitude = parseFloat(num[0].replace(",", "."));
  }
  // Явный знак минуса в десятичной записи уже в magnitude; полушарие мог его продублировать
  return { value: sign * Math.abs(magnitude), axis };
}

/**
 * Годится ли пара без градуса и полушария (см. COORD_MARKER_RE выше): либо обе
 * компоненты записаны с точностью ≥4 знаков, либо рядом стоит слово-маркер.
 * Пары с ° или полушарием самодостаточны — их не трогаем.
 */
function isAnchoredDecimalPair(text: string, raw: string, index: number): boolean {
  if (/[°'′"″]/u.test(raw) || HEMI_TAIL_RE.test(raw)) return true;
  const fractions = [...raw.matchAll(DEC_COMP_RE)].map((m) => m[0].split(/[.,]/)[1]?.length ?? 0);
  if (fractions.length >= 2 && fractions.every((f) => f >= BARE_DEC_MIN_FRACTION)) return true;
  const from = Math.max(0, index - COORD_MARKER_WINDOW);
  const to = Math.min(text.length, index + raw.length + COORD_MARKER_WINDOW);
  return COORD_MARKER_RE.test(text.slice(from, to));
}

/** Детектит WGS84-пары. Отбрасывает вне диапазона (lat±90, lon±180). */
function detectWGS84(text: string): DetectedCoord[] {
  const out: DetectedCoord[] = [];
  for (const m of text.matchAll(PAIR_RE)) {
    // Триммим краевые пробелы: \s* в компоненте мог захватить хвостовой пробел
    // (иначе одинаковые координаты дают разный raw → ломается дедуп).
    const lead = m[0].length - m[0].trimStart().length;
    const raw = m[0].trim();
    const index = m.index! + lead;
    if (!isAnchoredDecimalPair(text, raw, index)) continue;
    const comps = [...raw.matchAll(COMP_RE)].map((c) => parseComponent(c[0])).filter(Boolean) as {
      value: number;
      axis: "lat" | "lon" | null;
    }[];
    if (comps.length !== 2) continue;

    let latPart = comps.find((c) => c.axis === "lat");
    let lonPart = comps.find((c) => c.axis === "lon");
    // Нет явных полушарий → порядок по умолчанию: широта, потом долгота
    if (!latPart && !lonPart) {
      latPart = comps[0];
      lonPart = comps[1];
    } else if (latPart && !lonPart) {
      lonPart = comps.find((c) => c !== latPart);
    } else if (lonPart && !latPart) {
      latPart = comps.find((c) => c !== lonPart);
    }
    if (!latPart || !lonPart) continue;

    const lat = latPart.value;
    const lon = lonPart.value;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue; // не географическая пара

    out.push({ raw, index, system: "WGS84", lat, lon });
  }
  return out;
}

// ─── SK-42 (метровая проекционная СК): подпись X=/Y= либо маркер рядом ───────
//
// Х/У — не опечатка: кириллические Х (U+0425) и У (U+0423) визуально
// неотличимы от латинских X/Y и в РФ-документах встречаются вперемешку
// (та же путаница раскладки клавиатуры, что и везде в кириллических
// текстах) — поэтому оба алфавита сразу в классе символов, отдельная
// ветка на кириллицу не нужна.

const SK42_NUM_SRC = "(?<!\\d)\\d{6,8}(?:[.,]\\d+)?(?!\\d)"; // 6–8 цифр целой части (X/Y ± зона)
const SK42_NUM_RE = /\d{6,8}(?:[.,]\d+)?/gu; // тот же паттерн — для извлечения значений из raw

const X_LABEL = "[XxХх]";
const Y_LABEL = "[YyУу]";

// Подписанная пара X=.../Y=... — самодостаточный якорь, маркер СК рядом не
// нужен: такой подписи не бывает у цены/номера договора/ИНН.
const SK42_LABELED_PAIR_RE = new RegExp(
  `(?<![A-Za-zА-Яа-яЁё0-9])${X_LABEL}\\s*[=:]\\s*${SK42_NUM_SRC}\\s*[,;]?\\s+${Y_LABEL}\\s*[=:]\\s*${SK42_NUM_SRC}`,
  "gu",
);

// Голая пара чисел БЕЗ подписи — годится только рядом с явным маркером СК
// (см. hasSK42Marker ниже); без него неотличима от двух цен/номеров подряд.
const SK42_BARE_PAIR_RE = new RegExp(`${SK42_NUM_SRC}\\s*[,;]\\s*${SK42_NUM_SRC}`, "gu");

// Маркеры системы координат. МСК требует зонового суффикса «-NN»: голое
// «МСК» в РФ-документах — ЕЩЁ и трёхбуквенный префикс лицензии на
// недропользование (LICENSE_SUBSOIL в deid/detect.ts, формат «МСК 12345
// ТЭ») — без суффикса он от неё неотличим, отсюда обязательный «-NN».
const SK42_MARKER_RE =
  /(?<![A-Za-zА-Яа-яЁё0-9])(?:СК[-\s]?42|SK[-\s]?42|МСК-\d{1,2}|Пулково[-\s]?1942|систем[а-яё]*\s+координат\s+1942\s+года)(?![A-Za-zА-Яа-яЁё0-9])/iu;

const SK42_MARKER_WINDOW = 100; // символов в каждую сторону — «рядом», не «где-то в документе»

/** Маркер СК-42/МСК-NN/Пулково-1942 в окне вокруг найденной голой пары чисел. */
function hasSK42Marker(text: string, start: number, end: number): boolean {
  const from = Math.max(0, start - SK42_MARKER_WINDOW);
  const to = Math.min(text.length, end + SK42_MARKER_WINDOW);
  return SK42_MARKER_RE.test(text.slice(from, to));
}

function buildSK42Entry(match: string, matchIndex: number): DetectedCoord {
  // Тот же приём триммовки краевых пробелов, что и у WGS84 (см. detectWGS84).
  const lead = match.length - match.trimStart().length;
  const raw = match.trim();
  const index = matchIndex + lead;
  const [x, y] = [...raw.matchAll(SK42_NUM_RE)].map((n) => parseFloat(n[0].replace(",", ".")));
  return { raw, index, system: "SK-42", x, y };
}

/** Детектит SK-42-пары: подписанные X=/Y= самодостаточны, голые — только с маркером рядом. */
function detectSK42(text: string): DetectedCoord[] {
  const out: DetectedCoord[] = [];
  for (const m of text.matchAll(SK42_LABELED_PAIR_RE)) {
    out.push(buildSK42Entry(m[0], m.index!));
  }
  for (const m of text.matchAll(SK42_BARE_PAIR_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!hasSK42Marker(text, start, end)) continue;
    out.push(buildSK42Entry(m[0], start));
  }
  return out;
}

/** Отбрасывает пересекающиеся спаны (оставляет более ранний/длинный) — защита на случай
 *  редкого пересечения между семействами/паттернами; в норме WGS84 и SK-42 не пересекаются
 *  (разная длина целой части) и сами SK-42-паттерны структурно не могут матчить один спан дважды. */
function dropOverlaps(items: DetectedCoord[]): DetectedCoord[] {
  const sorted = [...items].sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
  const out: DetectedCoord[] = [];
  for (const it of sorted) {
    const end = it.index + it.raw.length;
    if (out.some((k) => it.index < k.index + k.raw.length && k.index < end)) continue;
    out.push(it);
  }
  return out;
}

/** Детектит все координаты (WGS84 + SK-42) в тексте. */
export function detectCoords(text: string): DetectedCoord[] {
  return dropOverlaps([...detectWGS84(text), ...detectSK42(text)]);
}
