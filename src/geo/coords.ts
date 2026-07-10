/**
 * Детекция географических координат в тексте (ts-spine, без сайдкара).
 *
 * Ловим ЯВНЫЕ координатные пары (с °/N/E/С/В маркерами либо ≥3 знаков после
 * запятой) — высокая точность, мало ложных срабатываний. Проекционные метровые
 * координаты (СК-42 в метрах) намеренно НЕ автодетектим: они неотличимы от прочих
 * больших чисел → это зона text-deid/человека-в-цикле, не гео-регекса.
 *
 * Координата — это PII (решение владельца, council): детектор нужен, чтобы
 * токенизировать её ДО облака. Числовая интерпретация (lat/lon) —
 * для «местной СК» (transform.ts); для самой токенизации хватает raw-подстроки.
 */

export interface GeoPoint {
  lat: number; // WGS84 широта, градусы
  lon: number; // WGS84 долгота, градусы
}

export interface DetectedCoord {
  raw: string; // исходная подстрока (её и заменяем на токен — round-trip точный)
  index: number; // позиция в тексте
  lat: number;
  lon: number;
}

// Полушария: широта (N/S/С/Ю), долгота (E/W/В/З), оба регистра
const HEMI = "NSEWnsewСЮВЗсювз";
const H_LAT = "NSnsСЮсю";
const H_NEG = "SWswЮЗюз"; // южное/западное → отрицательный знак

// Компонент координаты: DMS (град°мин'сек") либо десятичные градусы
const DMS_SRC = `\\d{1,3}\\s*°\\s*\\d{1,2}\\s*['′]\\s*(?:\\d{1,2}(?:[.,]\\d+)?\\s*["″])?\\s*[${HEMI}]?`;
const DEC_SRC = `[+-]?\\d{1,3}[.,]\\d{3,}\\s*°?\\s*[${HEMI}]?`;
const COMP_SRC = `(?:${DMS_SRC}|${DEC_SRC})`;
const PAIR_RE = new RegExp(`${COMP_SRC}\\s*[,;]?\\s+${COMP_SRC}`, "gu");
const COMP_RE = new RegExp(COMP_SRC, "gu");

/** Парсит одну компоненту → { value, axis } (axis: 'lat'|'lon'|null по полушарию). */
function parseComponent(s: string): { value: number; axis: "lat" | "lon" | null } | null {
  const hemiMatch = s.match(new RegExp(`[${HEMI}]\\s*$`, "u"));
  const hemi = hemiMatch ? hemiMatch[0].trim() : null;
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

/** Детектит все координатные пары. Отбрасывает вне диапазона (lat±90, lon±180). */
export function detectCoords(text: string): DetectedCoord[] {
  const out: DetectedCoord[] = [];
  for (const m of text.matchAll(PAIR_RE)) {
    // Триммим краевые пробелы: \s* в компоненте мог захватить хвостовой пробел
    // (иначе одинаковые координаты дают разный raw → ломается дедуп).
    const lead = m[0].length - m[0].trimStart().length;
    const raw = m[0].trim();
    const index = m.index! + lead;
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

    out.push({ raw, index, lat, lon });
  }
  return out;
}
