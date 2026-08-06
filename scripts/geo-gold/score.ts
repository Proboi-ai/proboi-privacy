/**
 * Шаг 3: свести независимую разметку с БОЕВЫМ детектором и посчитать полноту.
 *
 * Детектор берётся из рабочего дерева ядра (там, где живёт выкаченный код), а не из этого
 * репозитория: 05.08 гео-правки делались прямо в core, и proboi-privacy от них отстал —
 * мерить надо то, что реально работает у клиента.
 *
 * Конвейер повторяет components/text-deid.ts для правиловых типов:
 *   detectEntities → spreadGeoNames → spreadSurfaces → resolveOverlaps
 * NER-сайдкар не нужен: он закрывает только PER/ORG (SIDECAR_TYPES), а гео-типы — правила.
 *
 *   bun scripts/geo-gold/score.ts --chunks … --ann … --core /путь/к/worktree --out отчёт.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const CHUNKS = arg("chunks", ".work/geo-gold/chunks.jsonl")!;
const ANN = arg("ann", ".work/geo-gold/ann.jsonl")!;
const CORE = arg("core", "/Users/evgeniy/projects/proboi-core-geo-measure")!;
const OUT = arg("out", ".work/geo-gold/score.json")!;
const ADJ = arg("adj", "scripts/geo-gold/adjudication.json")!;

/**
 * Вердикты разбора эталона глазами. Без них цифра полноты врёт в обе стороны: разметка тащит
 * в эталон и номенклатуру листов Госгеолкарты, и перевёрнутый OCR-мусор, из которого модель
 * «прочитала» номера скважин. Значение без вердикта считается настоящим (верим разметке).
 */
const verdicts: Record<string, Record<string, string>> = JSON.parse(readFileSync(ADJ, "utf8"));
const verdictOf = (type: string, value: string) => verdicts[type]?.[value] ?? "in";

const { detectEntities, resolveOverlaps } = await import(`${CORE}/core/src/privacy/deid/detect.ts`);
const { spreadGeoNames } = await import(`${CORE}/core/src/privacy/deid/geo-spread.ts`);
const { spreadSurfaces } = await import(`${CORE}/core/src/privacy/deid/spread.ts`);
const { entitiesForVertical } = await import(`${CORE}/core/src/privacy/deid/entities.ts`);

type Ent = { type: string; raw: string; index: number };
const TYPES = entitiesForVertical("geo") as string[];
const MEASURED = ["WELL", "GEO_NAME", "LICENSE_SUBSOIL"] as const;
type Measured = (typeof MEASURED)[number];

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

/**
 * Детектор гоняем по ДОКУМЕНТУ ЦЕЛИКОМ, а считаем только по окну куска.
 *
 * Первая редакция замера гоняла его по куску в 3000 знаков — и это враньё в пользу
 * «детектор плохой»: прод обезличивает документ целиком, а обе протяжки (spreadGeoNames,
 * spreadSurfaces) закрывают значение по ВСЕМУ тексту, если хоть одно вхождение подтвердил
 * ключ. Нарезка рвёт эту связь: «скв. С-3» из шапки таблицы остаётся в соседнем куске, и
 * «(С-3)» в теле выглядит пропуском, которым в проде не является.
 */
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
/** Один документ разбирается детектором один раз, даже если из него взято два куска. */
const detectedCache = new Map<string, { type: string; start: number; end: number; raw: string }[]>();

type Ann = { chunk_id: string; находки: { тип: string; значение: string; фрагмент: string }[]; обрезано?: boolean };
const anns: Ann[] = readFileSync(ANN, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const norm = (t: string): Measured | null =>
  t === "LICENSE" || t === "LICENSE_SUBSOIL" ? "LICENSE_SUBSOIL"
  : t === "WELL" ? "WELL"
  : t === "GEO_NAME" ? "GEO_NAME"
  : null;

/** Ищем с допуском по пробелам: модель переносит текст, а таблицы полны неразрывных пробелов. */
function findFlexible(hay: string, needle: string, from = 0): number {
  const direct = hay.indexOf(needle, from);
  if (direct >= 0) return direct;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "u");
  const m = re.exec(hay.slice(from));
  return m ? from + m.index : -1;
}

/** `cands` — все вхождения значения внутри фрагмента разметки; закрыто ЛЮБОЕ = закрыт эталон. */
type Gold = { type: Measured; start: number; end: number; value: string; frag: string; cands: [number, number][] };
type Miss = { corpus: string; tier: string; chunk_id: string; type: string; value: string; ctx: string };

const stat: Record<string, { gold: number; found: number; foundOther: number }> = {};
const key = (type: string, corpus: string, tier: string) => `${type}|${corpus}|${tier}`;
const bump = (k: string, f: "gold" | "found" | "foundOther") => {
  stat[k] ??= { gold: 0, found: 0, foundOther: 0 };
  stat[k]![f] += 1;
};

const goldDump: (Miss & { found: boolean })[] = [];
const rejected: Record<string, number> = {};
const misses: Miss[] = [];
const unconfirmed: Miss[] = [];
let annTotal = 0, annDropped = 0, annDup = 0, truncated = 0;

for (const a of anns) {
  const c = chunks.get(a.chunk_id);
  if (!c) continue;
  if (a.обрезано) truncated += 1;

  // 1) разметка → спаны исходного текста
  const gold: Gold[] = [];
  const seen = new Set<string>();
  const usedFrom = new Map<string, number>(); // повторные вхождения одного значения идут дальше
  for (const f of a.находки ?? []) {
    const type = norm(f.тип);
    if (!type) continue;
    annTotal += 1;
    const value = (f.значение ?? "").trim();
    const frag = (f.фрагмент ?? "").trim();
    if (!value) { annDropped += 1; continue; }

    // Разметка указывает НА ФРАГМЕНТ и говорит «здесь есть сущность со значением X».
    // Куда именно внутри фрагмента она показывала — она не сообщает, и для короткого
    // значения (номер скважины «4», «12», «0») это решает всё: в буровом журнале такая
    // цифра встречается в одном фрагменте по нескольку раз.
    //
    // Первая редакция брала ПЕРВОЕ вхождение внутри фрагмента, а фрагмент, как правило,
    // начинается раньше ключа. Из-за этого «12» из «скважины № 12» приземлялось в
    // «Страница 12», «4» из «СКВАЖИНА № 4» — в номер пункта «4. Азимут линии», «0» из
    // «скважины № 0» — в «40,12 м». Детектор туда, разумеется, не попадал, и настоящая
    // находка рядом записывалась в пропуск. Замер 06.08: 8 из 43 «пропусков» WELL были
    // такими фантомами, то есть измеритель систематически врал В ПОЛЬЗУ «детектор плохой».
    //
    // Правильное чтение разметки: собираем ВСЕ вхождения значения внутри фрагмента и
    // считаем эталон закрытым, если детектор накрыл ЛЮБОЕ из них. Знаменатель при этом
    // остаётся прежним (одна находка разметки — один эталонный спан) и по-прежнему не
    // зависит от детектора: выбирать среди вхождений по признаку «рядом ключ» нельзя,
    // это настроило бы измеритель на измеряемое.
    const from = usedFrom.get(value) ?? 0;
    const cands: [number, number][] = [];
    const fragAt = frag ? findFlexible(c.text, frag, 0) : -1;
    if (fragAt >= 0) {
      const to = fragAt + frag.length + 40;
      for (let p = fragAt; p < to; ) {
        const at = findFlexible(c.text.slice(0, to), value, p);
        if (at < 0) break;
        cands.push([at, at + value.length]);
        p = at + 1;
      }
    }
    if (!cands.length) {
      const at = findFlexible(c.text, value, from);
      if (at >= 0) cands.push([at, at + value.length]);
    }
    if (!cands.length) { annDropped += 1; continue; }

    const [start, end] = cands[0]!;
    usedFrom.set(value, end);
    const k = `${type}:${start}:${end}`;
    if (seen.has(k)) { annDup += 1; continue; }
    seen.add(k);
    gold.push({ type, start, end, value, frag, cands });
  }

  // 2) боевой детектор — по документу целиком, спаны в координатах документа
  const docKey = `${c.corpus}:${c.doc_id}`;
  const full = docText.get(docKey);
  if (full === undefined) throw new Error(`нет текста документа ${docKey}`);
  // Смещение куска в документе: у клиентского корпуса нарезка шла ровно по offset, у
  // остальных — по границам строк, поэтому положение куска ищем, а не берём на веру.
  const base = full.startsWith(c.text, c.offset) ? c.offset : full.indexOf(c.text);
  if (base < 0) throw new Error(`кусок не найден в документе ${c.chunk_id}`);
  let spans = detectedCache.get(docKey)!;
  if (!spans) {
    spans = detect(full).map((e) => ({ type: e.type, start: e.index, end: e.index + e.raw.length, raw: e.raw }));
    detectedCache.set(docKey, spans);
  }
  const winFrom = base, winTo = base + c.text.length;
  const inWindow = spans.filter((s) => s.start < winTo && winFrom < s.end);
  // Эталонные спаны переводим в координаты документа — сравнение идёт в одной системе.
  for (const g of gold) {
    g.start += base; g.end += base;
    g.cands = g.cands.map(([s, e]) => [s + base, e + base]);
  }

  // 3) полнота: закрыт ли эталонный спан хоть каким-нибудь спаном детектора
  for (const g of gold) {
    const verdict = verdictOf(g.type, g.value);
    if (verdict !== "in") { rejected[verdict] = (rejected[verdict] ?? 0) + 1; continue; }
    const k = key(g.type, c.corpus, c.tier);
    bump(k, "gold");
    const hit = spans.filter((s) => g.cands.some(([gs, ge]) => s.start < ge && gs < s.end));
    goldDump.push({
      corpus: c.corpus, tier: c.tier, chunk_id: a.chunk_id, type: g.type, value: g.value,
      ctx: full.slice(Math.max(0, g.start - 70), g.end + 70).replace(/\s+/g, " "),
      found: hit.length > 0,
    });
    if (hit.some((s) => s.type === g.type)) bump(k, "found");
    else if (hit.length) bump(k, "foundOther");
    else {
      misses.push({
        corpus: c.corpus, tier: c.tier, chunk_id: a.chunk_id, type: g.type, value: g.value,
        ctx: full.slice(Math.max(0, g.start - 70), g.end + 70).replace(/\s+/g, " "),
      });
    }
  }

  // 4) обратная сторона: что детектор взял, а разметка не подтвердила (кандидаты в ложняки)
  for (const s of inWindow) {
    if (!MEASURED.includes(s.type as Measured)) continue;
    if (gold.some((g) => g.cands.some(([gs, ge]) => gs < s.end && s.start < ge))) continue;
    unconfirmed.push({
      corpus: c.corpus, tier: c.tier, chunk_id: a.chunk_id, type: s.type, value: s.raw,
      ctx: full.slice(Math.max(0, s.start - 70), s.end + 70).replace(/\s+/g, " "),
    });
  }
}

// ── отчёт
const agg = (filter: (corpus: string, tier: string) => boolean) => {
  const out: Record<string, { эталон: number; нашёл: number; нашёлДругимТипом: number; полнотаPct: number | null }> = {};
  for (const t of MEASURED) {
    let gold = 0, found = 0, other = 0;
    for (const [k, v] of Object.entries(stat)) {
      const [type, corpus, tier] = k.split("|") as [string, string, string];
      if (type !== t || !filter(corpus, tier)) continue;
      gold += v.gold; found += v.found; other += v.foundOther;
    }
    out[t] = {
      эталон: gold, нашёл: found, нашёлДругимТипом: other,
      полнотаPct: gold ? Math.round(((found + other) / gold) * 1000) / 10 : null,
    };
  }
  return out;
};

const corpora = [...new Set([...chunks.values()].map((c) => c.corpus))];
const report = {
  разметка: { всего: annTotal, неНайденоВТексте: annDropped, дубликаты: annDup, обрезанныхКусков: truncated, отклоненоРазбором: rejected },
  кусков: anns.length,
  всего: agg(() => true),
  слойB_обогащённый: agg((_, tier) => tier === "B"),
  слойA_представительный: agg((_, tier) => tier === "A"),
  поКорпусам: Object.fromEntries(corpora.map((c) => [c, agg((corpus) => corpus === c)])),
  методика:
    "эталон — независимая LLM-разметка по человеческому описанию сущностей; полнота = доля эталонных " +
    "спанов, перекрытых хоть одним спаном боевого детектора; расхождения обеих сторон выгружены для разбора глазами",
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
writeFileSync(OUT.replace(/\.json$/, "-misses.json"), JSON.stringify(misses, null, 2), "utf8");
writeFileSync(OUT.replace(/\.json$/, "-gold.json"), JSON.stringify(goldDump, null, 2), "utf8");
writeFileSync(OUT.replace(/\.json$/, "-unconfirmed.json"), JSON.stringify(unconfirmed, null, 2), "utf8");

console.log(JSON.stringify(report, null, 2));
console.log(`пропусков ${misses.length} → ${OUT.replace(/\.json$/, "-misses.json")}`);
console.log(`не подтверждено разметкой ${unconfirmed.length} → ${OUT.replace(/\.json$/, "-unconfirmed.json")}`);
