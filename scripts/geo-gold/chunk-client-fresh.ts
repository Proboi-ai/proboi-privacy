/**
 * Нарезка НОВОГО отложенного клиентского корпуса (fresh2, 06.08.2026 вечер) под разметку.
 * Замена сгоревшего holdout-20260806 (тот трижды смотрен при настройке WELL-детектора).
 *
 * Копия геометрии chunk-holdout.ts (весь корпус целиком, без выборки кусков внутри документа —
 * это ещё одна ручка подкрутки), НО с исправленной коллизией chunk_id из chunk-public-pool.ts:
 * doc_id НЕ усекается до 24 знаков — там, где это делал chunk-holdout.ts, разные документы с
 * длинным общим преф1иксом схлопывались в один chunk_id. Здесь doc_id короткий и опаковый
 * (fresh2-docx-NNN.docx / fresh2-pdf-NNN.pdf), но берём его целиком по тому же принципу —
 * не полагаться на "короткий сейчас = не усечётся".
 *
 *   bun chunk-client-fresh.ts --in fresh2-docx.jsonl --corpus client-fresh2-docx --out chunks-docx.jsonl
 *   bun chunk-client-fresh.ts --in fresh2-pdf.jsonl  --corpus client-fresh2-pdf  --out chunks-pdf.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const IN = arg("in")!;
const OUT = arg("out")!;
const CORPUS = arg("corpus")!;
const CHUNK = Number(arg("chunk", "3000"));
const MIN = Number(arg("min", "400"));
// Бюджет кусков НА ЭТОТ вызов (документ либо целиком внутри бюджета, либо не включается вовсе —
// как в chunk-public-pool.ts для eis-geo). По умолчанию без потолка.
const CHUNK_BUDGET = Number(arg("chunkBudget", "999999"));

interface Chunk {
  chunk_id: string;
  corpus: string;
  doc_id: string;
  offset: number;
  tier: "A";
  text: string;
}

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
  .map((l) => JSON.parse(l) as { doc_id: string; text: string })
  // короче → длиннее: при бюджете это включает БОЛЬШЕ РАЗНЫХ документов вместо того, чтобы
  // один гигант съел весь бюджет (тот же приём, что и в chunk-public-pool.ts для eis-geo).
  .sort((a, b) => a.text.length - b.text.length || a.doc_id.localeCompare(b.doc_id));

const chunks: Chunk[] = [];
let skippedShort = 0, skippedBudget = 0, keptDocs = 0;
for (const d of docs) {
  const cuts = cut(d.text, CHUNK).filter((c) => c.text.trim().length >= MIN);
  if (!cuts.length) { skippedShort += 1; continue; }
  if (chunks.length + cuts.length > CHUNK_BUDGET) { skippedBudget += 1; continue; }
  keptDocs += 1;
  for (const c of cuts) {
    chunks.push({
      chunk_id: `${CORPUS}:${d.doc_id}:${c.offset}`, // doc_id ЦЕЛИКОМ, без .slice(0, 24)
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
console.log(`документов во входе: ${docs.length}, включено: ${keptDocs} (пусто/коротко: ${skippedShort}, не влезло в бюджет: ${skippedBudget})`);
console.log(`кусков: ${chunks.length}, знаков: ${chars.toLocaleString("ru")}`);
console.log(`оценка стоимости разметки: ~$${(chunks.length * 0.007).toFixed(2)}`);
console.log(`→ ${OUT}`);
