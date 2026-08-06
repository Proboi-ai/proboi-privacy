/**
 * Шаг 1 замера ПОЛНОТЫ по COORD: нарезать выборку кусков текста, которую потом разметит
 * независимый аннотатор (LLM), а не наша же регулярка.
 *
 * Копия геометрии `scripts/geo-gold/sample.ts` (тот же ГПСЧ, та же нарезка, те же два слоя),
 * но признак слоя B — свой. Готовая выборка geo-gold для координат не годится: в её 220 кусках
 * запись «градусы-минуты» встретилась в ЧЕТЫРЁХ, потому что отбиралась она под скважины,
 * названия и лицензии.
 *
 * ⚠️ ЧЕМ ОБОГАЩАТЬ СЛОЙ B — главный вопрос честности замера. Отбирать куски по ФОРМЕ записи
 * (есть знак градуса / есть пара чисел) нельзя: тогда эталон соберётся ровно из того, что
 * детектор и так умеет искать, и полнота выйдет замером самого себя. Поэтому признак —
 * СМЫСЛОВОЙ: слова, которыми человек описывает привязку объекта к местности («координаты»,
 * «широта», «долгота», «угловые точки», «система координат»). Форма записи внутри такого
 * куска остаётся неизвестной — а именно она и меряется.
 *
 * Смещение при этом остаётся и его надо помнить: координата, записанная БЕЗ единого слова
 * рядом, в слой B не попадёт. Ровно для этого рядом идёт слой A — случайные куски без
 * всякого фильтра.
 *
 *   bun scripts/geo-coord/sample.ts --out .work/geo-coord/chunks.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const OUT = arg("out", ".work/geo-coord/chunks.jsonl")!;
const CHUNK = Number(arg("chunk", "3000"));
const SEED = Number(arg("seed", "20260806"));

/** Детерминированный ГПСЧ: выборка обязана воспроизводиться (Math.random — нет). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rnd = rng(SEED);
const shuffle = <T>(a: T[]): T[] => {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * Признак «кусок про привязку к местности» для слоя B. Только слова, ни одного шаблона записи.
 * «Пикет», «азимут», «отметка» намеренно НЕ включены: это соседи координаты по документу, но
 * сами координатами не являются, и куски с ними нужны как раз в слое A — проверить, не хватает
 * ли детектор лишнего.
 */
const COORD_HINTS = [
  /координат/iu,
  /широт|долгот/iu,
  /углов[а-яё]*\s+точ|поворотн[а-яё]*\s+точ|характерн[а-яё]*\s+точ/iu,
  /WGS[-\s]?84|СК[-\s]?42|МСК-\d|Пулково|ГСК[-\s]?2011|UTM|Гаусс/iu,
  /географическ[а-яё]*\s+(?:привязк|положени)|топографическ[а-яё]*\s+привязк/iu,
];
const coordHint = (t: string, min: number) => COORD_HINTS.filter((re) => re.test(t)).length >= min;

type Chunk = {
  chunk_id: string;
  corpus: string;
  doc_id: string;
  offset: number;
  tier: "A" | "B";
  text: string;
};

/** Режем по переводу строки, чтобы не рвать таблицу посреди строки. */
function cut(text: string, size: number): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + size * 0.5) end = nl;
    }
    out.push({ offset: i, text: text.slice(i, end) });
    i = end;
  }
  return out;
}

/**
 * Планы по объёму подогнаны под РЕДКОСТЬ сущности, а не взяты круглыми числами. Пересчёт по
 * корпусам: привязку к местности вообще упоминают 23 куска из 1288 у Роснедра, 45 из 1494 на
 * сканах и 137 из 13 511 у ЕИС. Поэтому слой B берётся ЦЕЛИКОМ (сколько есть), а не квотой —
 * иначе эталон выйдет в полтора десятка спанов, и любая цифра полноты будет шумом.
 */
const PLAN: { corpus: string; file: string; tierB: number; tierA: number; minHints: number }[] = [
  // Извещения Роснедра — жанр, где границы участка задают таблицей угловых точек.
  { corpus: "rosnedra", file: ".corpus/rosnedra.jsonl", tierB: 999, tierA: 10, minHints: 1 },
  // Распознанные геологические отчёты — другой жанр (сканы, шум распознавания).
  { corpus: "scans", file: ".corpus/scans.jsonl", tierB: 999, tierA: 10, minHints: 1 },
  // Закупки ЕИС «геологического» семейства: геология разбавлена сметами — отсюда два признака.
  { corpus: "eis-geo", file: ".corpus/texts.jsonl", tierB: 60, tierA: 10, minHints: 2 },
];
/**
 * Кусков из одного документа. У geo-gold было два — там сущности плотные и один длинный отчёт
 * съедал бы выборку. Здесь наоборот: координаты у Роснедра лежат в ДЕВЯТИ документах из 150,
 * и при пороге два вся таблица угловых точек в выборку не помещается.
 */
const PER_DOC = 4;

const chunks: Chunk[] = [];
for (const p of PLAN) {
  const docs = readFileSync(p.file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { doc_id: string; text: string });

  const all: Chunk[] = [];
  for (const d of shuffle(docs)) {
    for (const c of cut(d.text, CHUNK)) {
      if (c.text.trim().length < 400) continue;
      all.push({
        chunk_id: `${p.corpus}:${d.doc_id.slice(0, 24)}:${c.offset}`,
        corpus: p.corpus,
        doc_id: d.doc_id,
        offset: c.offset,
        tier: "A",
        text: c.text,
      });
    }
  }

  // Не больше двух кусков из одного документа: иначе выборку съедает один длинный отчёт.
  const perDoc = new Map<string, number>();
  const taken = new Set<string>();
  const take = (pool: Chunk[], n: number, tier: "A" | "B") => {
    const out: Chunk[] = [];
    for (const c of pool) {
      if (out.length >= n) break;
      if (taken.has(c.chunk_id)) continue;
      const used = perDoc.get(c.doc_id) ?? 0;
      if (used >= PER_DOC) continue;
      perDoc.set(c.doc_id, used + 1);
      taken.add(c.chunk_id);
      out.push({ ...c, tier });
    }
    return out;
  };

  const shuffled = shuffle(all);
  chunks.push(...take(shuffled.filter((c) => coordHint(c.text, p.minHints)), p.tierB, "B"));
  chunks.push(...take(shuffled, p.tierA, "A"));
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");

const by = (k: (c: Chunk) => string) =>
  chunks.reduce<Record<string, number>>((a, c) => ((a[k(c)] = (a[k(c)] ?? 0) + 1), a), {});
console.log(`кусков: ${chunks.length}, знаков: ${chunks.reduce((s, c) => s + c.text.length, 0).toLocaleString("ru")}`);
console.log("по корпусам:", by((c) => c.corpus));
console.log("по слоям:   ", by((c) => c.tier));
console.log(`→ ${OUT}`);
