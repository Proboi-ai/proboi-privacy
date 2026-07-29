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
const WORD_CHAR = /[\p{L}\p{Nd}]/u;
/** Пробелы, которые считаем разделителем: обычный, неразрывный и узкий неразрывный. */
const SPACES = new Set([" ", "\u00a0", "\u202f"]);

/**
 * Позиции подмен OCR, решённые ПО СЛОВУ ЦЕЛИКОМ, а не по соседям.
 *
 * По соседям не выходит: в «Koвaлёв» ведущая латинская «K» окружена пробелом слева и такой
 * же латинской «o» справа, и посимвольное правило её не берёт. Решение по слову же надёжно
 * в обе стороны: чинить смесь алфавитов внутри слова, где есть настоящая кириллица, и не
 * трогать честную латиницу («John Smith», «coop»), где кириллицы нет ни одной буквы.
 */
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
    for (const [k, ch] of word.entries()) {
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
  const chars = [...source];
  const fixups = ocrFixups(chars);
  let changed = false;
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

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
          map.push(k);
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
      map.push(i);
      changed = true;
      i++;
      continue;
    }

    if (ch === " " || ch === " " || ch === " ") {
      out.push(" ");
      map.push(i);
      changed = true;
      i++;
      continue;
    }

    out.push(ch);
    map.push(i);
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
