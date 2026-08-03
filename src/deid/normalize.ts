/**
 * Нормализация текста ПЕРЕД детекцией.
 *
 * ЗАЧЕМ. Замер на тексте из PDF, DOCX и сканов (`training/expanded/build_dirty_name_corpus.py`)
 * показал, что весь стек — правила, Natasha и GLiNER вместе — падает с 99.0% до 75.7%, а на
 * отдельных классах до 11%. Провалы дают не редкие, а самые обычные вещи:
 *
 *   «К о в а л ё в»   разрядка в заголовке          11.2%
 *   «КОВАЛЁВ Д.А.»    подпись капсом                38.5%
 *   «Ков-\nалёв»      перенос по слогам             87.8%
 *   «Koвaлёв»         латинские двойники после OCR  91.0%
 *   «0льга»           цифра вместо буквы            85.3%
 *
 * Это не нехватка ёмкости модели: на «К о в а л ё в» сломается любая модель, потому что
 * такого слова в языке нет. Зато всё перечисленное чинится ДЕТЕРМИНИРОВАННО и почти даром —
 * поэтому чиним здесь, а не корпусом и не размером сети.
 *
 * ОФСЕТЫ. Детекция идёт по нормализованному тексту, а значения в сейф и замены в документ —
 * по ИСХОДНОМУ. Поэтому нормализация несёт карту позиций: `map[i]` — откуда в оригинале
 * пришёл символ `i`. Так ошибка нормализации может стоить полноты, но НИКОГДА не искажает
 * ни выданный наружу текст, ни сохранённый оригинал.
 *
 * FAIL-OPEN. Любое сомнение — оставляем как есть: пропущенная нормализация стоит одного
 * шанса на детекцию, а лишняя может склеить чужие слова и наплодить ложные срабатывания.
 */

/** Латинские и греческие двойники кириллицы — ровно то, что подставляет OCR. */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т",
  X: "Х", Y: "У", I: "І", a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у",
  "Α": "А", "Β": "В", "Ε": "Е", "Κ": "К", "Μ": "М",
  "Ν": "Н", "Ο": "О", "Ρ": "Р", "Τ": "Т", "Χ": "Х",
};

/** Цифры, которые OCR ставит вместо букв. Применяются ТОЛЬКО внутри кириллического слова. */
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = { "0": "о", "3": "з", "6": "б", "9": "д" };

const CYRILLIC = /[А-Яа-яЁё]/u;
const LATIN = /[A-Za-z]/u;
const WORD_CHAR = /[\p{L}\p{Nd}]/u;
/**
 * Длина пробега латиницы, начиная с которой это настоящая латиница, а не порча OCR.
 *
 * OCR подменяет буквы поодиночке: в «Koвaлёв» латинские «K» и «a» стоят порознь среди
 * кириллицы. Три латинские буквы подряд так не появляются — это слипшееся английское
 * слово, чаще всего почта («Кирилловнаvetrova@…», договор ЕИС). Отличать обязательно:
 * подмена внутри такого пробега стирает границу слова, и стоящее перед ним отчество
 * перестаёт быть отдельным словом — человек уходит наружу открытым.
 */
const LATIN_RUN_IS_REAL = 3;
/** Пробелы, которые считаем разделителем: обычный, неразрывный и узкий неразрывный. */
const SPACES = new Set([" ", "\u00a0", "\u202f"]);

/**
 * \u041d\u0435\u0432\u0438\u0434\u0438\u043c\u044b\u0435 \u0441\u0438\u043c\u0432\u043e\u043b\u044b, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0441\u043d\u0438\u043c\u0430\u0435\u043c \u041f\u0415\u0420\u0415\u0414 \u0432\u0441\u0435\u043c \u043e\u0441\u0442\u0430\u043b\u044c\u043d\u044b\u043c.
 *
 * \u041d\u043e\u043b\u044c \u0448\u0438\u0440\u0438\u043d\u044b \u043d\u0435 \u0432\u0438\u0434\u0435\u043d \u0433\u043b\u0430\u0437\u043e\u043c, \u043d\u043e \u0434\u043b\u044f \u043a\u043e\u0434\u0430 \u044d\u0442\u043e \u043f\u043e\u043b\u043d\u043e\u0446\u0435\u043d\u043d\u044b\u0439 \u0441\u0438\u043c\u0432\u043e\u043b: \u043e\u043d \u0440\u0432\u0451\u0442 \u0441\u043b\u043e\u0432\u043e \u043d\u0430\u0434\u0432\u043e\u0435, \u0438
 * \u00ab\u041a\u043e\u0432\u0430\u200b\u043b\u0451\u0432\u00bb \u043f\u0435\u0440\u0435\u0441\u0442\u0430\u0451\u0442 \u0431\u044b\u0442\u044c \u0441\u043b\u043e\u0432\u043e\u043c \u0441\u0440\u0430\u0437\u0443 \u0434\u043b\u044f \u0432\u0441\u0435\u0445 \u043d\u0430\u0448\u0438\u0445 \u043f\u0440\u043e\u0431\u0435\u0433\u043e\u0432 \u2014 \u0438 \u0434\u043b\u044f \u043f\u0440\u0430\u0432\u0438\u043b, \u0438 \u0434\u043b\u044f
 * \u0441\u043a\u043b\u0435\u0439\u043a\u0438, \u0438 \u0434\u043b\u044f \u043f\u043e\u0447\u0438\u043d\u043a\u0438 OCR. \u041f\u0440\u0438\u043b\u0435\u0442\u0430\u0435\u0442 \u044d\u0442\u043e \u043d\u0435 \u043e\u0442 \u0437\u043b\u043e\u0443\u043c\u044b\u0448\u043b\u0435\u043d\u043d\u0438\u043a\u0430, \u0430 \u0438\u0437 \u043e\u0431\u044b\u0447\u043d\u043e\u0439 \u0432\u0451\u0440\u0441\u0442\u043a\u0438:
 * \u043a\u043e\u043f\u0438\u043f\u0430\u0441\u0442 \u0438\u0437 PDF \u0438 \u0438\u0437 \u0432\u0435\u0431\u0430 \u0442\u0430\u0449\u0438\u0442 ZWSP \u0438 BOM \u043f\u0430\u0447\u043a\u0430\u043c\u0438.
 *
 * \u041c\u044f\u0433\u043a\u043e\u0433\u043e \u043f\u0435\u0440\u0435\u043d\u043e\u0441\u0430 `\u00ad` \u0442\u0443\u0442 \u041d\u0415\u0422 \u043d\u0430\u043c\u0435\u0440\u0435\u043d\u043d\u043e: \u043e\u043d \u0440\u0430\u0437\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044f \u043d\u0438\u0436\u0435 \u0432\u043c\u0435\u0441\u0442\u0435 \u0441 \u043e\u0431\u044b\u0447\u043d\u044b\u043c \u0434\u0435\u0444\u0438\u0441\u043e\u043c,
 * \u0433\u0434\u0435 \u0440\u0435\u0448\u0435\u043d\u0438\u0435 \u043f\u0440\u0438\u043d\u0438\u043c\u0430\u0435\u0442\u0441\u044f \u043f\u043e \u0442\u043e\u043c\u0443, \u0447\u0442\u043e \u0441\u0442\u043e\u0438\u0442 \u043f\u043e\u0441\u043b\u0435 \u043f\u0435\u0440\u0435\u0432\u043e\u0434\u0430 \u0441\u0442\u0440\u043e\u043a\u0438.
 */
const INVISIBLE = new Set([
  "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u2060", "\ufeff",
]);

/** \u041f\u043e\u043b\u043d\u043e\u0448\u0438\u0440\u0438\u043d\u043d\u044b\u0435 \u0438 \u043f\u043e\u043b\u0443\u0448\u0438\u0440\u0438\u043d\u043d\u044b\u0435 \u0444\u043e\u0440\u043c\u044b \u2014 \u0432\u043e \u0447\u0442\u043e \u043f\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u044e\u0442 \u0442\u0435\u043a\u0441\u0442 \u043d\u0435\u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u043a\u043e\u043d\u0432\u0435\u0440\u0442\u0435\u0440\u044b. */
const WIDE = /[\uff01-\uff5e\uffe0-\uffee]/u;

/**
 * \u041f\u043e\u043b\u043d\u043e\u0448\u0438\u0440\u0438\u043d\u043d\u044b\u0439 \u0434\u0432\u043e\u0439\u043d\u0438\u043a \u2192 \u043e\u0431\u044b\u0447\u043d\u044b\u0439 \u0437\u043d\u0430\u043a, \u0421\u0422\u0420\u041e\u0413\u041e \u043e\u0434\u0438\u043d \u0441\u0438\u043c\u0432\u043e\u043b \u0432 \u043e\u0434\u0438\u043d.
 *
 * \u041f\u043e\u043b\u043d\u043e\u0448\u0438\u0440\u0438\u043d\u043d\u0430\u044f \u00ab\uff20\u00bb \u0438 \u0446\u0438\u0444\u0440\u044b \u00ab\uff10\uff11\uff12\u00bb \u043d\u0435 \u0441\u043e\u0432\u043f\u0430\u0434\u0443\u0442 \u043d\u0438 \u0441 \u043e\u0434\u043d\u043e\u0439 \u043d\u0430\u0448\u0435\u0439 \u043c\u0430\u0441\u043a\u043e\u0439 \u2014
 * \u043f\u043e\u0447\u0442\u0430 \u0438 \u0442\u0435\u043b\u0435\u0444\u043e\u043d \u0443\u0435\u0434\u0443\u0442 \u043d\u0430\u0440\u0443\u0436\u0443 \u043e\u0442\u043a\u0440\u044b\u0442\u044b\u043c\u0438. \u041b\u0435\u0447\u0438\u0442\u0441\u044f \u0448\u0442\u0430\u0442\u043d\u043e\u0439 NFKC, \u043d\u043e \u043f\u0440\u0438\u043c\u0435\u043d\u044f\u0442\u044c \u0435\u0451 \u0446\u0435\u043b\u0438\u043a\u043e\u043c
 * \u043d\u0435\u043b\u044c\u0437\u044f: NFKC \u0440\u0430\u0437\u0432\u043e\u0440\u0430\u0447\u0438\u0432\u0430\u0435\u0442 \u00ab\u2116\u00bb \u0432 \u00abNo\u00bb, \u0430 \u0432 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430\u0445 \u043d\u043e\u043c\u0435\u0440 \u0441\u0442\u043e\u0438\u0442 \u0432 \u043a\u0430\u0436\u0434\u043e\u043c \u0432\u0442\u043e\u0440\u043e\u043c \u0430\u0431\u0437\u0430\u0446\u0435.
 *
 * \u041e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d\u0438\u0435 \u00ab\u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u0440\u043e\u0432\u043d\u043e \u043e\u0434\u0438\u043d \u0441\u0438\u043c\u0432\u043e\u043b\u00bb \u0440\u0435\u0448\u0430\u0435\u0442 \u043e\u0431\u0435 \u0437\u0430\u0434\u0430\u0447\u0438 \u0440\u0430\u0437\u043e\u043c. \u041e\u043d\u043e \u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442 \u00ab\u2116\u00bb, \u00ab\u00bd\u00bb,
 * \u00ab\u33a1\u00bb \u0438 \u043b\u0438\u0433\u0430\u0442\u0443\u0440\u044b \u043d\u0435\u0442\u0440\u043e\u043d\u0443\u0442\u044b\u043c\u0438 \u2014 \u0443 \u043d\u0438\u0445 \u0440\u0430\u0441\u043a\u043b\u0430\u0434\u043a\u0430 \u0434\u043b\u0438\u043d\u043d\u0435\u0435 \u043e\u0434\u043d\u043e\u0433\u043e \u0437\u043d\u0430\u043a\u0430, \u2014 \u0438 \u043e\u0434\u043d\u043e\u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u0434\u0435\u0440\u0436\u0438\u0442
 * \u043a\u0430\u0440\u0442\u0443 \u043f\u043e\u0437\u0438\u0446\u0438\u0439 \u043e\u0434\u0438\u043d-\u0432-\u043e\u0434\u0438\u043d, \u0430 \u0437\u043d\u0430\u0447\u0438\u0442 \u0432\u044b\u0434\u0430\u043d\u043d\u044b\u0439 \u043d\u0430\u0440\u0443\u0436\u0443 \u0442\u0435\u043a\u0441\u0442 \u0441\u044a\u0435\u0445\u0430\u0442\u044c \u043d\u0435 \u043c\u043e\u0436\u0435\u0442.
 */
function unwiden(ch: string): string | undefined {
  if (!WIDE.test(ch)) return undefined;
  const plain = ch.normalize("NFKC");
  return [...plain].length === 1 && plain !== ch ? plain : undefined;
}

/** \u0422\u0435\u043a\u0441\u0442 \u0431\u0435\u0437 \u043d\u0435\u0432\u0438\u0434\u0438\u043c\u043e\u043a \u0438 \u043f\u043e\u043b\u043d\u043e\u0448\u0438\u0440\u0438\u043d\u043d\u044b\u0445 \u0444\u043e\u0440\u043c \u043f\u043b\u044e\u0441 \u043a\u0430\u0440\u0442\u0430 \u043f\u043e\u0437\u0438\u0446\u0438\u0439 \u0432 \u043e\u0440\u0438\u0433\u0438\u043d\u0430\u043b. */
interface Prepared {
  chars: string[];
  /** `origIndex[k]` \u2014 \u043f\u043e\u0437\u0438\u0446\u0438\u044f `chars[k]` \u0432 \u0438\u0441\u0445\u043e\u0434\u043d\u043e\u043c \u0442\u0435\u043a\u0441\u0442\u0435, \u0432 \u0442\u0435\u0445 \u0436\u0435 \u0435\u0434\u0438\u043d\u0438\u0446\u0430\u0445, \u0447\u0442\u043e \u0438 `map`. */
  origIndex: number[];
  changed: boolean;
}

/**
 * \u041f\u0440\u0435\u0434-\u043f\u0440\u043e\u0445\u043e\u0434: \u043e\u043d \u043e\u0431\u044f\u0437\u0430\u043d \u0438\u0434\u0442\u0438 \u0414\u041e \u0440\u0430\u0437\u0431\u043e\u0440\u0430 \u043d\u0430 \u0441\u043b\u043e\u0432\u0430.
 *
 * \u0412\u0441\u0435 \u043e\u0441\u0442\u0430\u043b\u044c\u043d\u044b\u0435 \u043f\u0440\u0435\u043e\u0431\u0440\u0430\u0437\u043e\u0432\u0430\u043d\u0438\u044f \u0447\u0438\u0442\u0430\u044e\u0442 \u043f\u0440\u043e\u0431\u0435\u0433\u0438 \u0441\u043b\u043e\u0432, \u0430 \u043d\u0435\u0432\u0438\u0434\u0438\u043c\u043a\u0430 \u0432\u043d\u0443\u0442\u0440\u0438 \u0441\u043b\u043e\u0432\u0430 \u044d\u0442\u0438 \u043f\u0440\u043e\u0431\u0435\u0433\u0438 \u0438
 * \u0440\u0432\u0451\u0442. \u041f\u043e\u0447\u0438\u043d\u0438\u0448\u044c \u0435\u0451 \u043f\u043e\u0442\u043e\u043c \u2014 \u0447\u0438\u043d\u0438\u0442\u044c \u0431\u0443\u0434\u0435\u0442 \u0443\u0436\u0435 \u043d\u0435\u0447\u0435\u0433\u043e: \u0441\u043b\u043e\u0432\u043e \u043a \u0442\u043e\u043c\u0443 \u043c\u043e\u043c\u0435\u043d\u0442\u0443 \u0440\u0430\u0437\u043e\u0431\u0440\u0430\u043d\u043e \u043d\u0430\u0434\u0432\u043e\u0435.
 */
function prepare(source: string): Prepared {
  const chars: string[] = [];
  const origIndex: number[] = [];
  let changed = false;
  let at = 0;
  for (const ch of source) {
    if (INVISIBLE.has(ch)) {
      changed = true;
      at++;
      continue;
    }
    const plain = unwiden(ch);
    if (plain !== undefined) changed = true;
    chars.push(plain ?? ch);
    origIndex.push(at);
    at++;
  }
  return { chars, origIndex, changed };
}

/**
 * Позиции подмен OCR, решённые ПО СЛОВУ ЦЕЛИКОМ, а не по соседям.
 *
 * По соседям не выходит: в «Koвaлёв» ведущая латинская «K» окружена пробелом слева и такой
 * же латинской «o» справа, и посимвольное правило её не берёт. Решение по слову же надёжно
 * в обе стороны: чинить смесь алфавитов внутри слова, где есть настоящая кириллица, и не
 * трогать честную латиницу («John Smith», «coop»), где кириллицы нет ни одной буквы.
 */
/** Индексы внутри слова, занятые пробегом латиницы длиной от `LATIN_RUN_IS_REAL`. */
function realLatinPositions(word: string[]): Set<number> {
  const out = new Set<number>();
  let i = 0;
  while (i < word.length) {
    if (!LATIN.test(word[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < word.length && LATIN.test(word[i]!)) i++;
    if (i - start >= LATIN_RUN_IS_REAL) for (let k = start; k < i; k++) out.add(k);
  }
  return out;
}

function ocrFixups(chars: string[]): Map<number, string> {
  const fix = new Map<number, string>();
  let i = 0;
  while (i < chars.length) {
    if (!WORD_CHAR.test(chars[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < chars.length && WORD_CHAR.test(chars[i]!)) i++;
    const word = chars.slice(start, i);
    const cyrillic = word.filter((c) => CYRILLIC.test(c)).length;
    if (cyrillic === 0) continue; // слово целиком латинское — это не порча, а иностранное слово
    const realLatin = realLatinPositions(word);
    for (const [k, ch] of word.entries()) {
      if (realLatin.has(k)) continue; // внутри настоящего латинского слова чинить нечего
      const homoglyph = HOMOGLYPHS[ch];
      if (homoglyph !== undefined) {
        fix.set(start + k, homoglyph);
        continue;
      }
      // Цифра вместо буквы — только когда в слове есть на что опереться и оно не номер.
      const digit = DIGIT_LOOKALIKES[ch];
      if (digit !== undefined && cyrillic >= 2 && !word.some((c) => /\d/u.test(c) && c !== ch)) {
        const atWordStart = k === 0;
        fix.set(start + k, atWordStart ? digit.toUpperCase() : digit);
      }
    }
  }
  return fix;
}

/**
 * Позиции, ПЕРЕД которыми надо вставить пробел: слова слиплись без разделителя.
 *
 * «ЖуравлёваСемёнаМихайловича» — типовой артефакт извлечения текста из PDF: пробелы
 * между словами не размечены вовсе, и ФИО приезжает одним словом. Ни правило, ни модель
 * такого слова не знают, и человек уходит в облако открытым (поймано на договорах ЕИС 29.07).
 *
 * Признак узкий НАМЕРЕННО: внутри русского слова заглавной буквы не бывает, но бывает в
 * названиях («СберБанк», «МосОблГаз»), а их разрезать незачем. Поэтому режем только длинные
 * слова (≥14 знаков) минимум с ДВУМЯ переходами «строчная → заглавная»: столько границ подряд
 * даёт склейка нескольких слов, а не фирменное написание.
 */
function gluedWordSplits(chars: string[]): Set<number> {
  const out = new Set<number>();
  let i = 0;
  while (i < chars.length) {
    if (!CYRILLIC.test(chars[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < chars.length && CYRILLIC.test(chars[i]!)) i++;
    if (i - start < 14) continue;
    const boundaries: number[] = [];
    for (let k = start + 1; k < i; k++) {
      const prev = chars[k - 1]!;
      const ch = chars[k]!;
      if (prev === prev.toLowerCase() && ch !== ch.toLowerCase()) boundaries.push(k);
    }
    if (boundaries.length >= 2) for (const b of boundaries) out.add(b);
  }
  return out;
}

/**
 * Позиции стыка «кириллица ↔ латиница» внутри одного слова: там пропал разделитель.
 *
 * Пропуск пробела перед латиницей — типовой артефакт извлечения текста: почта приклеивается
 * к предыдущему слову («Кирилловнаvetrova@example.ru»), и отчество перестаёт быть отдельным
 * словом. Правилам и модели такое слово незнакомо, человек уходит наружу открытым.
 *
 * Порог в три буквы с ОБЕИХ сторон намеренный: он отделяет пропавший пробел от порчи OCR,
 * где латинские двойники стоят поодиночке среди кириллицы и их надо чинить, а не резать.
 */
function scriptSplits(chars: string[]): Set<number> {
  const out = new Set<number>();
  let i = 0;
  while (i < chars.length) {
    if (!WORD_CHAR.test(chars[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < chars.length && WORD_CHAR.test(chars[i]!)) i++;
    let runStart = start;
    for (let k = start + 1; k <= i; k++) {
      const prev = chars[k - 1]!;
      const ch = k < i ? chars[k]! : "";
      const flip =
        k === i ||
        (CYRILLIC.test(prev) && LATIN.test(ch)) ||
        (LATIN.test(prev) && CYRILLIC.test(ch));
      if (!flip) continue;
      const isLast = k === i;
      const runLong = k - runStart >= LATIN_RUN_IS_REAL;
      if (!isLast && runLong) {
        // Резать можно, только если и справа полноценный пробег, а не одинокий двойник.
        let j = k;
        const sameScript = LATIN.test(ch) ? LATIN : CYRILLIC;
        while (j < i && sameScript.test(chars[j]!)) j++;
        if (j - k >= LATIN_RUN_IS_REAL) out.add(k);
      }
      runStart = k;
    }
  }
  return out;
}

export interface Normalized {
  /** Текст для детекции. */
  text: string;
  /** `map[i]` — индекс в исходном тексте, откуда пришёл символ `text[i]`. */
  map: number[];
  /** Нормализация ничего не изменила — можно работать с оригиналом напрямую. */
  unchanged: boolean;
}

/** Позиция в ИСХОДНОМ тексте для спана, найденного в нормализованном. */
export function toSourceSpan(n: Normalized, start: number, end: number): [number, number] {
  if (n.unchanged) return [start, end];
  const from = n.map[start] ?? 0;
  // Конец берём по последнему включённому символу: `map` хранит начала, и `map[end]`
  // указывал бы уже на следующий символ, теряя хвост при схлопывании.
  const lastIndex = Math.max(start, end - 1);
  const to = (n.map[lastIndex] ?? from) + 1;
  return [from, Math.max(to, from)];
}

/**
 * Разрядка: «К о в а л ё в» → конец цепочки, иначе 0.
 *
 * Цепочка считается ПО ТОКЕНАМ, а не по буквам: каждый участник обязан быть отдельным
 * словом из одной буквы. Посимвольный счёт затягивал первую букву следующего слова —
 * «работы в и з районе» схлопывалось в «работы визрайоне».
 *
 * Порог — четыре буквы: «в и з» встречается в обычном тексте, «К о в а л ё в» — нет.
 * Разделитель ровно один пробел: в разрядке зазор между СЛОВАМИ шире, и по нему проходит
 * граница («К о в а л ё в  Д. А.» — фамилия схлопывается, инициалы остаются на месте).
 */
function spacedRunEnd(chars: string[], from: number): number {
  let i = from;
  let letters = 0;
  let end = from;
  while (i < chars.length && CYRILLIC.test(chars[i]!)) {
    const next = chars[i + 1];
    // Токен длиннее одной буквы — это уже обычное слово, цепочка кончилась ПЕРЕД ним.
    if (next !== undefined && !SPACES.has(next)) break;
    letters++;
    end = i;
    if (next === undefined || !SPACES.has(next)) break;
    if (SPACES.has(chars[i + 2] ?? "")) break; // широкий зазор — граница слова
    i += 2;
  }
  return letters >= 4 ? end + 1 : 0;
}

/**
 * Приводит текст к виду, на котором работают правила и модель.
 *
 * Порядок важен: сначала посимвольные замены (офсеты сохраняются один-в-один), потом
 * удаляющие преобразования — перенос по слогам и разрядка.
 */
export function normalizeForDetection(source: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  const { chars, origIndex, changed: prepared } = prepare(source);
  const fixups = ocrFixups(chars);
  const splits = new Set([...gluedWordSplits(chars), ...scriptSplits(chars)]);
  let changed = prepared;
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

    // Слипшиеся слова разделяем пробелом. Пробел ВСТАВЛЯЕТСЯ, поэтому в карту позиций он
    // идёт с индексом следующего символа: спан, начавшийся со слова справа, вернётся в
    // исходные координаты без сдвига.
    if (splits.has(i)) {
      out.push(" ");
      map.push(origIndex[i]!);
      changed = true;
    }

    // Перенос по слогам: «Ков-\nалёв» → «Ковалёв». Дефис и перевод строки выбрасываем,
    // но только между буквами — иначе пострадают составные фамилии и списки через тире.
    if ((ch === "-" || ch === "‐" || ch === "­") && CYRILLIC.test(chars[i - 1] ?? "")) {
      let j = i + 1;
      while (j < chars.length && (chars[j] === " " || chars[j] === "\r")) j++;
      if (chars[j] === "\n") {
        j++;
        while (j < chars.length && (chars[j] === " " || chars[j] === "\t")) j++;
        // Строчная после переноса — это продолжение слова. Заглавная означала бы новую
        // строку списка («Иванов -\nПетров»), там дефис осмысленный.
        if (j < chars.length && CYRILLIC.test(chars[j]!) && chars[j] === chars[j]!.toLowerCase()) {
          changed = true;
          i = j;
          continue;
        }
      }
    }

    // Разрядка: «К о в а л ё в» → «Ковалёв». Начинать разрешено ТОЛЬКО с начала слова:
    // иначе цепочка стартует с последней буквы предыдущего слова и склеивает его с
    // именем («составил К о в а л ё в» → «составилКовалёв»).
    if (
      CYRILLIC.test(ch) &&
      SPACES.has(chars[i + 1] ?? "") &&
      !WORD_CHAR.test(chars[i - 1] ?? "")
    ) {
      const end = spacedRunEnd(chars, i);
      if (end > 0) {
        for (let k = i; k < end; k += 2) {
          out.push(chars[k]!);
          map.push(origIndex[k]!);
        }
        changed = true;
        i = end;
        continue;
      }
    }

    // Подмены OCR решены заранее по слову целиком — см. ocrFixups.
    const fixed = fixups.get(i);
    if (fixed !== undefined) {
      out.push(fixed);
      map.push(origIndex[i]!);
      changed = true;
      i++;
      continue;
    }

    if (ch === " " || ch === " " || ch === " ") {
      out.push(" ");
      map.push(origIndex[i]!);
      changed = true;
      i++;
      continue;
    }

    out.push(ch);
    map.push(origIndex[i]!);
    i++;
  }

  return changed ? { text: out.join(""), map, unchanged: false } : { text: source, map, unchanged: true };
}

/**
 * Вариант текста для движков, требующих «Заглавная + строчные».
 *
 * Подписи и штампы набирают капсом («КОВАЛЁВ Д.А.»), и на них падают и правила, и модель —
 * 38.5% на замере. Приводим ТОЛЬКО длинные капсовые слова: короткие — это аббревиатуры
 * (ООО, ИНН, НИИ), их регистр осмыслен, и трогать его нельзя. Длина строки не меняется,
 * поэтому офсеты остаются общими с исходным текстом.
 */
export function softenAllCaps(source: string): string {
  return source.replace(/[А-ЯЁ]{5,}(?:[-‑][А-ЯЁ]{2,})*/gu, (word) =>
    word.charAt(0) + word.slice(1).toLowerCase(),
  );
}
