/**
 * CLI замера полноты гео-детекторов на реальных текстах.
 *
 * Вход: JSONL со строками {"doc_id": "...", "text": "..."} (--texts) либо каталог
 * .txt-файлов (--dir). Запускать ТАМ, где лежат тексты (EC-3090 — через
 * runner-exec, батчами: синхронный вызов живёт 30–60 с, см. память 01.08).
 *
 * Наружу из отчёта можно отдавать ТОЛЬКО счётчики (поле "типы"); примеры
 * пропусков ("примерыПропусков") содержат сырые значения — локальный разбор.
 *
 *   bun scripts/measure-geo-recall.ts --texts texts.jsonl --out report.json
 *   bun scripts/measure-geo-recall.ts --dir ./txt --out report.json --samples 0
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureGeoRecall } from "../src/validation-geo";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const textsPath = arg("texts");
const dirPath = arg("dir");
const outPath = arg("out") ?? "geo-recall-report.json";
const samples = Number(arg("samples") ?? "20");

const docs: { id: string; text: string }[] = [];
if (textsPath) {
  for (const line of readFileSync(textsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    docs.push({ id: row.doc_id ?? row.id, text: row.text });
  }
} else if (dirPath) {
  for (const f of readdirSync(dirPath)) {
    if (!f.endsWith(".txt")) continue;
    docs.push({ id: f, text: readFileSync(join(dirPath, f), "utf8") });
  }
} else {
  console.error("нужен --texts file.jsonl или --dir каталог");
  process.exit(2);
}

const report = measureGeoRecall(docs, { sampleCap: samples });
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

console.log(`документов: ${report.документов}`);
for (const [type, t] of Object.entries(report.типы)) {
  const pct = t.полнотаPct === null ? "— (сеть ничего не нашла)" : `${t.полнотаPct}%`;
  console.log(
    `${type.padEnd(16)} в исходном ${String(t.вИсходном).padStart(6)}  ` +
      `осталось ${String(t.осталосьПослеМаски).padStart(5)}  полнота ${pct}`,
  );
}
console.log(`отчёт → ${outPath} (примеры пропусков НЕ отдавать наружу)`);
