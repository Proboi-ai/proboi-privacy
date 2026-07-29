/**
 * PDF: контроль собранного артефакта.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ «ОБЕЗЛИЧИВАНИЯ PDF». Правка готового PDF — это перерисовка страницы:
 * текст лежит позиционированными кусками в шрифтовой кодировке, и замена «Иванов И.П.» на
 * ярлык другой ширины ломает вёрстку либо оставляет исходные глифы в потоке. Наш маршрут
 * другой и сохраняет гарантию целиком:
 *
 *   входящий PDF  → текст извлекается конвейером ядра → де-ид ТЕКСТА (`deid/detect.ts`)
 *   исходящий PDF → модель отдаёт содержимое с ярлыками → `restoreText` подставляет
 *                   оригиналы ДО рендера → PDF собирается уже с настоящими именами
 *                   на машине клиента.
 *
 * То есть подстановка делается над текстом, а этот модуль отвечает за последний шаг —
 * доказать, что в готовом файле нет того, чего там быть не должно, и что подстановка
 * действительно произошла (не остался висеть ярлык).
 *
 * ЧЕСТНЫЙ ПРЕДЕЛ. Полное извлечение текста из произвольного PDF без разбора встроенных
 * шрифтов невозможно: subset-шрифт со своей кодировкой без `ToUnicode` читается только
 * вместе со шрифтом. Поэтому `assertPdfContainsNone` ищет значение и в извлечённом тексте,
 * и в сырых распакованных потоках в трёх кодировках — этого достаточно для файлов,
 * собранных типовыми генераторами, но проверку ДО рендера она не заменяет.
 */

import { inflateSync } from "node:zlib";

/** Начало и конец бинарного потока внутри PDF. */
const STREAM_RE = /stream\r?\n?/gu;
const END_STREAM = "endstream";

/** Текстовые операторы: (строка) Tj · [(a) -20 (b)] TJ · (строка) ' · (строка) " */
const LITERAL_RE = /\((?:\\.|[^\\()])*\)/gsu;
const HEX_RE = /<([0-9A-Fa-f\s]+)>/gu;

/** Кириллица в CP1251: 0xC0–0xFF → А–я, плюс ё/Ё. */
function fromCp1251(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte >= 0xc0) out += String.fromCharCode(byte + 0x350);
    else if (byte === 0xa8) out += "Ё";
    else if (byte === 0xb8) out += "ё";
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** Разворачивает экранирование строкового литерала PDF: \( \) \\ \n \ddd. */
function decodeLiteral(literal: string): Uint8Array {
  const body = literal.slice(1, -1);
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== "\\") {
      out.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && body[i + 1] && body[i + 1]! >= "0" && body[i + 1]! <= "7") {
        octal += body[++i]!;
      }
      out.push(parseInt(octal, 8) & 0xff);
      continue;
    }
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    out.push(escapes[next] ?? (next.charCodeAt(0) & 0xff));
  }
  return Uint8Array.from(out);
}

/** UTF-16BE с BOM — типовой способ положить кириллицу в PDF-строку. */
function decodeBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return out;
  }
  return fromCp1251(bytes);
}

/** Все потоки файла в распакованном виде; нераспаковываемые возвращаются как есть. */
function streams(bytes: Uint8Array): Uint8Array[] {
  const raw = Buffer.from(bytes);
  const latin = raw.toString("latin1");
  const out: Uint8Array[] = [];
  for (const match of latin.matchAll(STREAM_RE)) {
    const start = match.index! + match[0].length;
    const end = latin.indexOf(END_STREAM, start);
    if (end < 0) continue;
    const chunk = raw.subarray(start, end);
    try {
      out.push(new Uint8Array(inflateSync(chunk)));
    } catch {
      out.push(new Uint8Array(chunk)); // несжатый поток либо чужой фильтр — берём как есть
    }
  }
  return out;
}

/**
 * Извлекает читаемый текст. Годится для проверки собранного файла и для грубого поиска;
 * полноценным экстрактором (со шрифтами и порядком строк) НЕ является — см. шапку файла.
 */
export function extractPdfText(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const stream of streams(bytes)) {
    const content = Buffer.from(stream).toString("latin1");
    if (!/\b(?:Tj|TJ|'|")\B|\bTj\b|\bTJ\b/u.test(content)) {
      // Не страница с текстом (картинка, шрифт, метаданные) — но XMP всё равно полезен.
      if (content.includes("<?xpacket")) parts.push(content);
      continue;
    }
    for (const literal of content.match(LITERAL_RE) ?? []) {
      parts.push(decodeBytes(decodeLiteral(literal)));
    }
    for (const hex of content.matchAll(HEX_RE)) {
      const digits = hex[1]!.replace(/\s/gu, "");
      if (digits.length < 4 || digits.length % 2 !== 0) continue;
      const raw = Uint8Array.from(
        digits.match(/../gu)!.map((pair) => parseInt(pair, 16)),
      );
      parts.push(decodeBytes(raw));
    }
  }
  return parts.join(" ");
}

/** Те же символы в трёх представлениях, которыми кириллица попадает в PDF. */
function encodings(value: string): string[] {
  const utf16 = [...value].map((c) => c.charCodeAt(0)).flatMap((code) => [code >> 8, code & 0xff]);
  const cp1251 = [...value].map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 0x410 && code <= 0x44f) return code - 0x350;
    if (code === 0x401) return 0xa8;
    if (code === 0x451) return 0xb8;
    return code & 0xff;
  });
  return [
    value,
    String.fromCharCode(...utf16),
    String.fromCharCode(...cp1251),
    Buffer.from(value, "utf8").toString("latin1"),
  ];
}

/**
 * Проверяет, что в собранном PDF не осталось исходных значений. Смотрит извлечённый текст,
 * сырые распакованные потоки (в трёх кодировках) и сам файл — последнее ловит значения в
 * `/Info` (`/Author`, `/Title`), которые лежат вне страничных потоков.
 */
export function assertPdfContainsNone(bytes: Uint8Array, forbidden: Iterable<string>): void {
  const values = [...new Set(forbidden)].filter(Boolean);
  if (!values.length) return;

  const text = extractPdfText(bytes);
  const haystacks = [
    text,
    Buffer.from(bytes).toString("latin1"),
    ...streams(bytes).map((stream) => Buffer.from(stream).toString("latin1")),
  ];

  for (const value of values) {
    const variants = encodings(value);
    if (haystacks.some((hay) => variants.some((variant) => hay.includes(variant)))) {
      throw new Error("PDF содержит исходное значение");
    }
  }
}

/**
 * Проверяет, что в собранном PDF не осталось НЕподставленных ярлыков.
 *
 * Обратная сторона той же гарантии: висящий `[PER_01]` в готовом отчёте — не утечка, но
 * именно та претензия, с которой приходит служба ИБ («документ пришёл битым»).
 */
export function findPdfPlaceholders(bytes: Uint8Array): string[] {
  const text = extractPdfText(bytes);
  return [...new Set(text.match(/\[[A-ZА-ЯЁ][A-ZА-ЯЁ0-9_]*[_\s-]?\d{1,6}\]/gu) ?? [])];
}
