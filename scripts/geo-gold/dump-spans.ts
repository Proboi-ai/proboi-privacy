/**
 * Выгрузка «эталон + находки правил» в один JSONL, чтобы дальше считать в питоне.
 *
 * Зачем отдельный шаг. Проверяльщики (`verify_coord.py`, `verify_license.py`) живут в питоне
 * рядом с корпусами, а боевой детектор — в TypeScript в ядре. Гонять детектор из питона нечем,
 * а переписывать проверяльщик на TS до того, как он себя оправдал, — преждевременно. Поэтому
 * TS выгружает то, что умеет только он (боевые спаны по документу целиком), а вся арифметика
 * связки живёт в одном месте.
 *
 * Конвейер детектора — тот же, что в `score.ts` и в проде (`components/text-deid.ts`):
 * detectEntities → spreadGeoNames → spreadSurfaces → resolveOverlaps, по ДОКУМЕНТУ целиком,
 * с последующим окном по куску. Иначе протяжки видят не тот контекст и спаны разъезжаются.
 *
 * Эталон берётся из независимой LLM-разметки и фильтруется вердиктами слепого разбора
 * (`adjudication*.json`): значение с вердиктом не «in» в эталон не идёт.
 *
 * `--core` ОБЯЗАН указывать на дерево, собранное ОТ `origin/master`. Локальная копия детектора
 * в этом репозитории (`src/deid/detect.ts`) стейджинговая: 09.08 она отставала от боевой на 437
 * строк, и на ней «правила» показывали GEO_NAME 56,6 вместо 68,4 и WELL 63,2 вместо 84,4.
 * Дерево заводится и удаляется под замер, чтобы не копить worktree:
 *
 *   git -C ~/projects/proboi-core worktree add --detach ~/projects/proboi-core-geo-lab origin/master
 *
 *   bun scripts/geo-gold/dump-spans.ts \
 *     --chunks .work/geo-gold/chunks-fresh2.jsonl \
 *     --ann    .work/geo-gold/ann-fresh2.jsonl \
 *     --adj    scripts/geo-gold/adjudication-fresh2.json \
 *     --core   ~/projects/proboi-core-geo-lab \
 *     --out    .work/geo-fix/spans-fresh2.jsonl
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const CHUNKS = arg("chunks")!;
const ANN = arg("ann")!;
const ADJ = arg("adj");
const CORE = arg("core") ?? (() => { throw new Error("нужен --core: дерево от origin/master, см. докстринг"); })();
const OUT = arg("out")!;
/** Какой тип разметки тащим в эталон. Пусто ⇒ все, какие есть. */
const ONLY = arg("only");

const verdicts: Record<string, string> = ADJ && existsSync(ADJ) ? JSON.parse(readFileSync(ADJ, "utf8")) : {};
const verdictOf = (value: string) => verdicts[value] ?? "in";

const { detectEntities, resolveOverlaps } = await import(`${CORE}/core/src/privacy/deid/detect.ts`);
const { spreadGeoNames } = await import(`${CORE}/core/src/privacy/deid/geo-spread.ts`);
const { spreadSurfaces } = await import(`${CORE}/core/src/privacy/deid/spread.ts`);
const { entitiesForVertical } = await import(`${CORE}/core/src/privacy/deid/entities.ts`);

type Ent = { type: string; raw: string; index: number };
const TYPES = entitiesForVertical("geo") as string[];

function detect(text: string): Ent[] {
  let ents = detectEntities(text, TYPES) as Ent[];
  if (TYPES.includes("GEO_NAME")) ents = resolveOverlaps([...ents, ...spreadGeoNames(text, ents)]);
  ents = resolveOverlaps([...ents, ...spreadSurfaces(text, ents)]);
  return ents;
}

type Chunk = { chunk_id: string; corpus: string; tier: string; text: string; doc_id: string; offset: number };
const chunks = new Map<string, Chunk>();
for (const l of readFileSync(CHUNKS, "utf8").split("\n")) {
  if (l.trim()) { const c = JSON.parse(l) as Chunk; chunks.set(c.chunk_id, c); }
}

const CORPUS_FILES: Record<string, string> = {
  "eis-geo": ".corpus/texts.jsonl",
  scans: ".corpus/scans.jsonl",
  rosnedra: ".corpus/rosnedra.jsonl",
  "client-scans": ".corpus/client-scans.jsonl",
};
const docText = new Map<string, string>();
for (const corpus of new Set([...chunks.values()].map((c) => c.corpus))) {
  const file = CORPUS_FILES[corpus] ?? (existsSync(`.corpus/${corpus}.jsonl`) ? `.corpus/${corpus}.jsonl` : undefined);
  if (!file) throw new Error(`неизвестный корпус: ${corpus}`);
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as { doc_id: string; text: string };
    docText.set(`${corpus}:${r.doc_id}`, r.text);
  }
}

type Ann = { chunk_id: string; находки?: { тип: string; значение: string; фрагмент: string }[]; обрезано?: boolean };
const anns: Ann[] = readFileSync(ANN, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Поиск с допуском по пробелам: разметка переносит текст, а таблицы полны неразрывных пробелов. */
function findFlexible(hay: string, needle: string, from = 0): number {
  const direct = hay.indexOf(needle, from);
  if (direct >= 0) return direct;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "u");
  const m = re.exec(hay.slice(from));
  return m ? from + m.index : -1;
}

const detectedCache = new Map<string, { type: string; start: number; end: number; raw: string }[]>();
const rows: string[] = [];
let annDropped = 0, annRejected = 0;

for (const a of anns) {
  const c = chunks.get(a.chunk_id);
  if (!c) continue;

  const gold: { type: string; start: number; end: number; value: string }[] = [];
  const seen = new Set<string>();
  const usedFrom = new Map<string, number>();
  for (const f of a.находки ?? []) {
    const type = (f.тип ?? "").trim();
    if (ONLY && type !== ONLY) continue;
    const value = (f.значение ?? "").trim();
    const frag = (f.фрагмент ?? "").trim();
    if (!value) { annDropped += 1; continue; }
    if (verdictOf(value) !== "in") { annRejected += 1; continue; }

    const from = usedFrom.get(value) ?? 0;
    let start = -1;
    const fragAt = frag ? findFlexible(c.text, frag, 0) : -1;
    if (fragAt >= 0) {
      const inFrag = findFlexible(c.text.slice(fragAt, fragAt + frag.length + 40), value);
      if (inFrag >= 0) start = fragAt + inFrag;
    }
    if (start < 0) start = findFlexible(c.text, value, from);
    if (start < 0) { annDropped += 1; continue; }

    const end = start + value.length;
    usedFrom.set(value, end);
    const k = `${type}:${start}:${end}`;
    if (seen.has(k)) continue;
    seen.add(k);
    gold.push({ type, start, end, value });
  }

  const docKey = `${c.corpus}:${c.doc_id}`;
  const full = docText.get(docKey);
  if (full === undefined) throw new Error(`нет текста документа ${docKey}`);
  const base = full.startsWith(c.text, c.offset) ? c.offset : full.indexOf(c.text);
  if (base < 0) throw new Error(`кусок не найден в документе ${c.chunk_id}`);
  let spans = detectedCache.get(docKey);
  if (!spans) {
    spans = detect(full).map((e) => ({ type: e.type, start: e.index, end: e.index + e.raw.length, raw: e.raw }));
    detectedCache.set(docKey, spans);
  }
  // Окно куска: спан считаем «в куске», если он с ним пересекается; координаты — от начала куска
  // (могут выйти за границы, если правило захватило слово за краем — это честно и видно).
  const winTo = base + c.text.length;
  const rules = spans
    .filter((s) => s.start < winTo && base < s.end)
    .map((s) => ({ type: s.type, start: s.start - base, end: s.end - base, raw: s.raw }));

  rows.push(JSON.stringify({
    chunk_id: a.chunk_id, corpus: c.corpus, doc_id: c.doc_id, tier: c.tier,
    text: c.text, gold, rules,
  }));
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rows.join("\n") + "\n", "utf8");
console.log(`кусков ${rows.length} → ${OUT}; разметки не найдено в тексте ${annDropped}, отклонено разбором ${annRejected}`);
