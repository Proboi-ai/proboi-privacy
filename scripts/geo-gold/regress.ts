/**
 * Обратная сторона замера: что правка ЗАСТАВИЛА детектор находить.
 *
 * Полнота растёт легко — достаточно ослабить правила, и вместе с пропусками закроется
 * половина обычного текста. Поэтому каждая правка гоняется на ЧУЖИХ жанрах (судебные
 * решения, финансовые раскрытия) старой и новой сборкой, и сравниваются счётчики и сами
 * новые находки. Правило проекта: смотреть не на процент, а на формы — глазами.
 *
 *   bun scripts/geo-gold/regress.ts --base /путь/к/базовому/worktree --new /путь/к/правленому \
 *     --corpus .corpus/court.jsonl --docs 800 --out .work/geo-gold/regress-court.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const BASE = arg("base", "/Users/evgeniy/projects/proboi-core-geo-base")!;
const NEW = arg("new", "/Users/evgeniy/projects/proboi-core-geo-measure")!;
const CORPUS = arg("corpus", ".corpus/court.jsonl")!;
const DOCS = Number(arg("docs", "500"));
const OUT = arg("out", ".work/geo-gold/regress.json")!;
const TYPES_ARG = (arg("types", "GEO_NAME,WELL,LICENSE_SUBSOIL") ?? "").split(",");

async function loadDetector(root: string) {
  const { detectEntities, resolveOverlaps } = await import(`${root}/core/src/privacy/deid/detect.ts`);
  const { spreadGeoNames } = await import(`${root}/core/src/privacy/deid/geo-spread.ts`);
  const { spreadSurfaces } = await import(`${root}/core/src/privacy/deid/spread.ts`);
  const { entitiesForVertical } = await import(`${root}/core/src/privacy/deid/entities.ts`);
  const types = entitiesForVertical("geo") as string[];
  return (text: string) => {
    let ents = detectEntities(text, types);
    if (types.includes("GEO_NAME")) ents = resolveOverlaps([...ents, ...spreadGeoNames(text, ents)]);
    return resolveOverlaps([...ents, ...spreadSurfaces(text, ents)]) as { type: string; raw: string; index: number }[];
  };
}

const base = await loadDetector(BASE);
const fixed = await loadDetector(NEW);

const docs: { doc_id: string; text: string }[] = [];
for (const l of readFileSync(CORPUS, "utf8").split("\n")) {
  if (!l.trim()) continue;
  if (docs.length >= DOCS) break;
  docs.push(JSON.parse(l));
}

const key = (e: { type: string; raw: string; index: number }) => `${e.type}:${e.index}:${e.raw}`;
const cntBase: Record<string, number> = {};
const cntNew: Record<string, number> = {};
const appeared: { type: string; raw: string; ctx: string }[] = [];
const vanished: { type: string; raw: string; ctx: string }[] = [];
let chars = 0;

for (const d of docs) {
  chars += d.text.length;
  const b = base(d.text).filter((e) => TYPES_ARG.includes(e.type));
  const n = fixed(d.text).filter((e) => TYPES_ARG.includes(e.type));
  for (const e of b) cntBase[e.type] = (cntBase[e.type] ?? 0) + 1;
  for (const e of n) cntNew[e.type] = (cntNew[e.type] ?? 0) + 1;
  const bk = new Set(b.map(key));
  const nk = new Set(n.map(key));
  for (const e of n) {
    if (!bk.has(key(e)) && appeared.length < 400) {
      appeared.push({ type: e.type, raw: e.raw, ctx: d.text.slice(Math.max(0, e.index - 60), e.index + e.raw.length + 60).replace(/\s+/g, " ") });
    }
  }
  for (const e of b) {
    if (!nk.has(key(e)) && vanished.length < 200) {
      vanished.push({ type: e.type, raw: e.raw, ctx: d.text.slice(Math.max(0, e.index - 60), e.index + e.raw.length + 60).replace(/\s+/g, " ") });
    }
  }
}

const report = { корпус: CORPUS, документов: docs.length, знаков: chars, было: cntBase, стало: cntNew, появилось: appeared.length, исчезло: vanished.length };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ ...report, новыеНаходки: appeared, пропавшиеНаходки: vanished }, null, 2), "utf8");
console.log(JSON.stringify(report, null, 1));
