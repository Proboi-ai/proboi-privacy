/**
 * Шаг 3: свести независимую разметку COORD с БОЕВЫМ детектором и посчитать полноту.
 *
 * Копия `scripts/geo-gold/score.ts`, переведённая на один тип COORD. Детектор берётся из
 * рабочего дерева ядра (там, где живёт код), а не из этого репозитория.
 *
 * Конвейер повторяет components/text-deid.ts для правиловых типов:
 *   detectEntities → spreadGeoNames → spreadSurfaces → resolveOverlaps
 * (протяжки COORD не касаются, но пусть конвейер будет тем же — иначе спаны других типов
 * могут разойтись и «нашёл другим типом» посчитается иначе, чем в проде).
 *
 *   bun scripts/geo-coord/score.ts --chunks … --ann … --core /путь/к/worktree --out отчёт.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const CHUNKS = arg("chunks", ".work/geo-coord/chunks.jsonl")!;
const ANN = arg("ann", ".work/geo-coord/ann.jsonl")!;
const CORE = arg("core", "/Users/evgeniy/projects/proboi-core-geo-coords")!;
const OUT = arg("out", ".work/geo-coord/score.json")!;
const ADJ = arg("adj", "scripts/geo-coord/adjudication.json")!;

/**
 * Вердикты разбора эталона глазами. Разметка тащит в эталон и то, что координатой не является
 * (грид-линии координатной сетки, номера профилей, обрывки OCR). Значение без вердикта
 * считается настоящим — верим разметке, пока не разобрали.
 */
const verdicts: Record<string, string> = JSON.parse(readFileSync(ADJ, "utf8"));
const verdictOf = (value: string) => verdicts[value] ?? "in";

const { detectEntities, resolveOverlaps } = await import(`${CORE}/core/src/privacy/deid/detect.ts`);
const { spreadGeoNames } = await import(`${CORE}/core/src/privacy/deid/geo-spread.ts`);
const { spreadSurfaces } = await import(`${CORE}/core/src/privacy/deid/spread.ts`);
const { entitiesForVertical } = await import(`${CORE}/core/src/privacy/deid/entities.ts`);

type Ent = { type: string; raw: string; index: number };
const TYPES = entitiesForVertical("geo") as string[];
const MEASURED = "COORD";

/** Боевой конвейер для правиловых типов. */
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

/** Детектор гоняем по ДОКУМЕНТУ ЦЕЛИКОМ, а считаем только по окну куска (как в geo-gold). */
const CORPUS_FILES: Record<string, string> = {
  "eis-geo": ".corpus/texts.jsonl",
  scans: ".corpus/scans.jsonl",
  rosnedra: ".corpus/rosnedra.jsonl",
  "client-scans": ".corpus/client-scans.jsonl",
};
const docText = new Map<string, string>();
for (const corpus of new Set([...chunks.values()].map((c) => c.corpus))) {
  // Новый корпус не требует правки этого файла: имя корпуса = имя файла в .corpus/.
  // Явная карта выше осталась для исторических имён, которые файлу не соответствуют.
  const file = CORPUS_FILES[corpus] ?? (existsSync(`.corpus/${corpus}.jsonl`) ? `.corpus/${corpus}.jsonl` : undefined);
  if (!file) throw new Error(`неизвестный корпус: ${corpus}`);
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as { doc_id: string; text: string };
    docText.set(`${corpus}:${r.doc_id}`, r.text);
  }
}
const detectedCache = new Map<string, { type: string; start: number; end: number; raw: string }[]>();

type Ann = { chunk_id: string; находки: { тип: string; значение: string; фрагмент: string }[]; обрезано?: boolean };
const anns: Ann[] = readFileSync(ANN, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Ищем с допуском по пробелам: модель переносит текст, а таблицы полны неразрывных пробелов. */
function findFlexible(hay: string, needle: string, from = 0): number {
  const direct = hay.indexOf(needle, from);
  if (direct >= 0) return direct;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "u");
  const m = re.exec(hay.slice(from));
  return m ? from + m.index : -1;
}

type Gold = { start: number; end: number; value: string; frag: string };
type Row = { corpus: string; tier: string; chunk_id: string; value: string; ctx: string };

const stat: Record<string, { gold: number; found: number }> = {};
const key = (corpus: string, tier: string) => `${corpus}|${tier}`;
const bump = (k: string, f: "gold" | "found") => {
  stat[k] ??= { gold: 0, found: 0 };
  stat[k]![f] += 1;
};

const goldDump: (Row & { found: boolean })[] = [];
const rejected: Record<string, number> = {};
const misses: Row[] = [];
const unconfirmed: Row[] = [];
let annTotal = 0, annDropped = 0, annDup = 0, truncated = 0;

for (const a of anns) {
  const c = chunks.get(a.chunk_id);
  if (!c) continue;
  if (a.обрезано) truncated += 1;

  // 1) разметка → спаны исходного текста
  const gold: Gold[] = [];
  const seen = new Set<string>();
  const usedFrom = new Map<string, number>();
  for (const f of a.находки ?? []) {
    annTotal += 1;
    const value = (f.значение ?? "").trim();
    const frag = (f.фрагмент ?? "").trim();
    if (!value) { annDropped += 1; continue; }

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
    const k = `${start}:${end}`;
    if (seen.has(k)) { annDup += 1; continue; }
    seen.add(k);
    gold.push({ start, end, value, frag });
  }

  // 2) боевой детектор — по документу целиком, спаны в координатах документа
  const docKey = `${c.corpus}:${c.doc_id}`;
  const full = docText.get(docKey);
  if (full === undefined) throw new Error(`нет текста документа ${docKey}`);
  const base = full.startsWith(c.text, c.offset) ? c.offset : full.indexOf(c.text);
  if (base < 0) throw new Error(`кусок не найден в документе ${c.chunk_id}`);
  let spans = detectedCache.get(docKey)!;
  if (!spans) {
    spans = detect(full).map((e) => ({ type: e.type, start: e.index, end: e.index + e.raw.length, raw: e.raw }));
    detectedCache.set(docKey, spans);
  }
  const winFrom = base, winTo = base + c.text.length;
  const inWindow = spans.filter((s) => s.start < winTo && winFrom < s.end);
  for (const g of gold) { g.start += base; g.end += base; }

  // 3) полнота: закрыт ли эталонный спан спаном COORD
  for (const g of gold) {
    const verdict = verdictOf(g.value);
    if (verdict !== "in") { rejected[verdict] = (rejected[verdict] ?? 0) + 1; continue; }
    const k = key(c.corpus, c.tier);
    bump(k, "gold");
    const hit = spans.filter((s) => s.type === MEASURED && s.start < g.end && g.start < s.end);
    goldDump.push({
      corpus: c.corpus, tier: c.tier, chunk_id: a.chunk_id, value: g.value,
      ctx: full.slice(Math.max(0, g.start - 70), g.end + 70).replace(/\s+/g, " "),
      found: hit.length > 0,
    });
    if (hit.length) bump(k, "found");
    else misses.push({
      corpus: c.corpus, tier: c.tier, chunk_id: a.chunk_id, value: g.value,
      ctx: full.slice(Math.max(0, g.start - 70), g.end + 70).replace(/\s+/g, " "),
    });
  }

  // 4) обратная сторона: что детектор взял, а разметка не подтвердила (кандидаты в ложняки)
  for (const s of inWindow) {
    if (s.type !== MEASURED) continue;
    if (gold.some((g) => g.start < s.end && s.start < g.end)) continue;
    unconfirmed.push({
      corpus: c.corpus, tier: c.tier, chunk_id: a.chunk_id, value: s.raw,
      ctx: full.slice(Math.max(0, s.start - 70), s.end + 70).replace(/\s+/g, " "),
    });
  }
}

const agg = (filter: (corpus: string, tier: string) => boolean) => {
  let gold = 0, found = 0;
  for (const [k, v] of Object.entries(stat)) {
    const [corpus, tier] = k.split("|") as [string, string];
    if (!filter(corpus, tier)) continue;
    gold += v.gold; found += v.found;
  }
  return { эталон: gold, нашёл: found, полнотаPct: gold ? Math.round((found / gold) * 1000) / 10 : null };
};

const corpora = [...new Set([...chunks.values()].map((c) => c.corpus))];
const report = {
  разметка: { всего: annTotal, неНайденоВТексте: annDropped, дубликаты: annDup, обрезанныхКусков: truncated, отклоненоРазбором: rejected },
  кусков: anns.length,
  всего: agg(() => true),
  слойB_обогащённый: agg((_, tier) => tier === "B"),
  слойA_представительный: agg((_, tier) => tier === "A"),
  поКорпусам: Object.fromEntries(corpora.map((c) => [c, agg((corpus) => corpus === c)])),
  неПодтвержденоРазметкой: unconfirmed.length,
  методика:
    "эталон — независимая LLM-разметка по человеческому описанию координаты; полнота = доля эталонных " +
    "спанов, перекрытых спаном COORD боевого детектора; расхождения обеих сторон выгружены для разбора глазами",
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
writeFileSync(OUT.replace(/\.json$/, "-misses.json"), JSON.stringify(misses, null, 2), "utf8");
writeFileSync(OUT.replace(/\.json$/, "-gold.json"), JSON.stringify(goldDump, null, 2), "utf8");
writeFileSync(OUT.replace(/\.json$/, "-unconfirmed.json"), JSON.stringify(unconfirmed, null, 2), "utf8");

console.log(JSON.stringify(report, null, 2));
console.log(`пропусков ${misses.length} → ${OUT.replace(/\.json$/, "-misses.json")}`);
console.log(`не подтверждено разметкой ${unconfirmed.length} → ${OUT.replace(/\.json$/, "-unconfirmed.json")}`);
