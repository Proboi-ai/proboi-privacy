/**
 * Нарезка НОВОГО пула публичных документов (`texts.jsonl`/`scans.jsonl`/`rosnedra.jsonl`),
 * которых ЕЩЁ НЕТ в существующей разметке. Копия геометрии `chunk-holdout.ts`: документ режется
 * ЦЕЛИКОМ, без выборки кусков ВНУТРИ него — выборка кусков это ещё одна ручка подкрутки, её
 * быть не должно.
 *
 * Исключение уже размеченных документов делается через ДВОЙНОЙ join, а не через усечённый
 * doc_id из chunk_id напрямую (`corpus:doc_id.slice(0,24):offset`) — у rosnedra doc_id это
 * длинные имена файлов, и усечение до 24 знаков даёт коллизии (14 групп, до 16 разных
 * документов на одну и ту же 24-символьную приставку). Поэтому: chunk_id из ann*.jsonl →
 * ПОЛНЫЙ doc_id через тот же chunks.jsonl, которым эта разметка делалась (там doc_id хранится
 * нетронутым отдельным полем) → множество (corpus, doc_id) уже использованных документов.
 *
 * По той же причине НАШ chunk_id тут НЕ усекает doc_id до 24 знаков, как в sample.ts/
 * chunk-holdout.ts — на пилоте это дало реальную коллизию: два РАЗНЫХ документа rosnedra
 * (`departament_morgeo_izveshchaet_o_provedenii_konkursa_na_pravo_zaklyucheniya_kontrakta...`
 * и `..._na_vypolnenie_rabot_po_geologicheskomu_izucheniyu...`) совпали по 24-символьной
 * приставке И по offset=0, и оба легли в ann-файл под ОДНИМ chunk_id — это ломает и dedup при
 * возобновлении прогона, и обратное сопоставление находок документу. Здесь chunk_id несёт
 * doc_id ЦЕЛИКОМ.
 *
 * eis-geo (закупки ЕИС) — жанр с очень длинными документами (медиана ~40к знаков ≈ 13
 * кусков/документ, максимум 1,3 млн знаков ≈ 440 кусков ОДНОГО документа). Полный корпус
 * (10 410 кусков) стоит ≈$77 — не влезает в потолок $25, и один гигантский документ
 * доминировал бы выборкой — а это ровно та проблема (корреляция находок внутри документа),
 * ради решения которой расширяется корпус. Поэтому eis-geo не режется целиком: документы
 * берутся короткие→длинные (детерминированно, по длине текста), каждый включается ЦЕЛИКОМ
 * (все его куски) или не включается вовсе, пока не будет исчерпан выделенный бюджет кусков.
 * scans/rosnedra дёшевы и конечны — берутся целиком без бюджета.
 *
 *   bun scripts/geo-gold/chunk-public-pool.ts \
 *     --out .work/geo-gold/chunks-public-pool.jsonl --eisChunkBudget 2000
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const OUT = arg("out", ".work/geo-gold/chunks-public-pool.jsonl")!;
const CHUNK = Number(arg("chunk", "3000"));
const MIN = Number(arg("min", "400"));
const EIS_CHUNK_BUDGET = Number(arg("eisChunkBudget", "999999"));

type Chunk = {
  chunk_id: string;
  corpus: string;
  doc_id: string;
  offset: number;
  tier: "A";
  text: string;
};

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

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

// 1. Построить множество уже использованных (corpus, doc_id) — через chunks.jsonl тех же
// двух харнессов (geo-gold и geo-coord), у которых chunk_id → doc_id хранится нетронутым.
type ChunkRow = { chunk_id: string; corpus: string; doc_id: string };
const used = new Set<string>();
let usedChunksTotal = 0;
let usedResolvable = 0;

for (const [chunksFile, annFile] of [
  [".work/geo-gold/chunks.jsonl", ".work/geo-gold/ann.jsonl"],
  [".work/geo-coord/chunks.jsonl", ".work/geo-coord/ann.jsonl"],
] as const) {
  const chunkMap = new Map<string, ChunkRow>();
  for (const c of readJsonl<ChunkRow>(chunksFile)) chunkMap.set(c.chunk_id, c);

  for (const a of readJsonl<{ chunk_id: string }>(annFile)) {
    usedChunksTotal++;
    const row = chunkMap.get(a.chunk_id);
    if (!row) continue; // не найдено соответствие — не считаем использованным (не подгадываем)
    usedResolvable++;
    used.add(`${row.corpus} ${row.doc_id}`);
  }
}
console.log(
  `использованных чанков в ann.jsonl (geo-gold+geo-coord): ${usedChunksTotal}, из них разрешилось до doc_id: ${usedResolvable}, уникальных документов исключено: ${used.size}`,
);

// 2. Три публичных корпуса.
const PLAN: { corpus: string; file: string }[] = [
  { corpus: "eis-geo", file: ".corpus/texts.jsonl" },
  { corpus: "scans", file: ".corpus/scans.jsonl" },
  { corpus: "rosnedra", file: ".corpus/rosnedra.jsonl" },
];

const chunks: Chunk[] = [];
const summary: Record<
  string,
  { total: number; excluded: number; kept: number; chunks: number; chars: number }
> = {};

for (const p of PLAN) {
  const allDocs = readJsonl<{ doc_id: string; text: string }>(p.file);
  const excludedCount = allDocs.filter((d) => used.has(`${p.corpus} ${d.doc_id}`)).length;
  let candidates = allDocs.filter((d) => !used.has(`${p.corpus} ${d.doc_id}`));
  candidates = candidates.sort((a, b) =>
    p.corpus === "eis-geo"
      ? a.text.length - b.text.length || a.doc_id.localeCompare(b.doc_id)
      : a.doc_id.localeCompare(b.doc_id),
  );

  const s = { total: allDocs.length, excluded: excludedCount, kept: 0, chunks: 0, chars: 0 };
  const budget = p.corpus === "eis-geo" ? EIS_CHUNK_BUDGET : Number.POSITIVE_INFINITY;
  for (const d of candidates) {
    const cuts = cut(d.text, CHUNK).filter((c) => c.text.trim().length >= MIN);
    // документ целиком не влезает в остаток бюджета — пропускаем ВЕСЬ документ, не режем частично
    if (s.chunks + cuts.length > budget) continue;
    s.kept++;
    for (const c of cuts) {
      s.chunks++;
      s.chars += c.text.length;
      chunks.push({
        chunk_id: `${p.corpus}:${d.doc_id}:${c.offset}`,
        corpus: p.corpus,
        doc_id: d.doc_id,
        offset: c.offset,
        tier: "A",
        text: c.text,
      });
    }
  }
  summary[p.corpus] = s;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");

const totalChunks = chunks.length;
const totalChars = chunks.reduce((s, c) => s + c.text.length, 0);
const totalKeptDocs = Object.values(summary).reduce((s, v) => s + v.kept, 0);
console.log("по корпусам:", JSON.stringify(summary, null, 2));
console.log(
  `ИТОГО документов новых: ${totalKeptDocs}, кусков: ${totalChunks}, знаков: ${totalChars.toLocaleString("ru")}`,
);
console.log(`оценка стоимости разметки при $0,00736/кусок: $${(totalChunks * 0.00736).toFixed(2)}`);
console.log(`→ ${OUT}`);
