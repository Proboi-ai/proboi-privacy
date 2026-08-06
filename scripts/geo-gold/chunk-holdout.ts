/**
 * Нарезка ОТЛОЖЕННОГО корпуса `holdout-20260806` под разметку.
 *
 * Отличие от `sample.ts`: здесь НЕТ выборки. Корпус отобран заранее (90 PDF, сид 20260806,
 * жанровая стратификация по имени файла на машине клиента) и распознан прод-путём 06.08.
 * Берём его ЦЕЛИКОМ, все куски всех документов, слой один — «A, представительный».
 *
 * Почему целиком, а не выборкой:
 *  • отбор кусков внутри корпуса — ещё одна ручка, которой можно незаметно подкрутить цифру;
 *  • по LICENSE_SUBSOIL эталон и так кратно недобран (23 спана на прошлом корпусе), и каждый
 *    выброшенный кусок — это выброшенные эталонные спаны;
 *  • разметка стоит ~$0,007 за кусок, то есть полный корпус ≈ полтора доллара. Экономить
 *    здесь нечего, а «почему взяли именно эти куски» пришлось бы объяснять в каждой цифре.
 *
 * Корпус одноразовый: после разметки он ВИДЕН и для следующей приёмки не годится. Собрать
 * новый дёшево — `scripts/ec3090/select-holdout.ps1` плюс ~$0,4 на распознавание.
 *
 *   bun scripts/geo-gold/chunk-holdout.ts \
 *     --in .corpus/holdout-20260806.jsonl --out .work/geo-gold/chunks-holdout.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const IN = arg("in", ".corpus/holdout-20260806.jsonl")!;
const OUT = arg("out", ".work/geo-gold/chunks-holdout.jsonl")!;
const CORPUS = arg("corpus", "holdout-20260806")!;
const CHUNK = Number(arg("chunk", "3000"));
const MIN = Number(arg("min", "400"));

interface Chunk {
  chunk_id: string;
  corpus: string;
  doc_id: string;
  offset: number;
  tier: "A";
  text: string;
}

/** Режем по границе строки, если она близко к концу окна: иначе рвём таблицу посреди строки. */
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

const docs = readFileSync(IN, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { doc_id: string; text: string });

const chunks: Chunk[] = [];
let skipped = 0;
for (const d of docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id))) {
  for (const c of cut(d.text, CHUNK)) {
    if (c.text.trim().length < MIN) { skipped += 1; continue; }
    chunks.push({
      chunk_id: `${CORPUS}:${d.doc_id.slice(0, 24)}:${c.offset}`,
      corpus: CORPUS,
      doc_id: d.doc_id,
      offset: c.offset,
      tier: "A",
      text: c.text,
    });
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");

const chars = chunks.reduce((s, c) => s + c.text.length, 0);
console.log(`документов: ${docs.length}`);
console.log(`кусков: ${chunks.length} (отброшено коротких ${skipped}), знаков: ${chars.toLocaleString("ru")}`);
console.log(`оценка стоимости разметки: ~$${(chunks.length * 0.007).toFixed(2)}`);
console.log(`→ ${OUT}`);
