/**
 * Калибровка РАЗМЕТЧИКА (06.08): согласие двух независимых разметок одного и того же куска.
 *
 * Вопрос не «какая модель лучше по метрике», а «можно ли подменить критерий истины».
 * Поэтому считаем в ОБЕ стороны: A как эталон и B как проверяемый, и наоборот. Ни одна из
 * двух не истина, и одностороннее число («B нашла 80 % от A») само по себе ничего не решает.
 *
 * Спаны эталона строятся ТЕМ ЖЕ кодом, что в score.ts (фрагмент → все вхождения значения
 * внутри него), иначе сравнивались бы два разных чтения одной разметки.
 *
 *   bun scripts/geo-gold/agree.ts --chunks … --a ann-A.jsonl --b ann-B.jsonl --out отчёт.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const CHUNKS = arg("chunks", ".work/geo-gold/chunks-calib.jsonl")!;
const A = arg("a", ".work/geo-gold/ann-calib-gemini.jsonl")!;
const B = arg("b", ".work/geo-gold/ann-calib-gonka.jsonl")!;
const LABEL_A = arg("label-a", "A")!;
const LABEL_B = arg("label-b", "B")!;
const OUT = arg("out", ".work/geo-gold/AGREE.json")!;

type Chunk = { chunk_id: string; text: string; doc_id: string };
const chunks = new Map<string, Chunk>();
for (const l of readFileSync(CHUNKS, "utf8").split("\n")) {
  if (l.trim()) { const c = JSON.parse(l) as Chunk; chunks.set(c.chunk_id, c); }
}

type Ann = { chunk_id: string; находки?: { тип: string; значение: string; фрагмент: string }[] };
const load = (p: string) => {
  const m = new Map<string, Ann>();
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (l.trim()) { const a = JSON.parse(l) as Ann; m.set(a.chunk_id, a); }
  }
  return m;
};
const annA = load(A), annB = load(B);

const MEASURED = ["WELL", "GEO_NAME", "LICENSE_SUBSOIL"] as const;
type Measured = (typeof MEASURED)[number];
const norm = (t: string): Measured | null =>
  t === "LICENSE" || t === "LICENSE_SUBSOIL" ? "LICENSE_SUBSOIL"
  : t === "WELL" ? "WELL"
  : t === "GEO_NAME" ? "GEO_NAME"
  : null;

/** Копия допуска по пробелам из score.ts: модель переносит текст, таблицы полны NBSP. */
function findFlexible(hay: string, needle: string, from = 0): number {
  const direct = hay.indexOf(needle, from);
  if (direct >= 0) return direct;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "u");
  const m = re.exec(hay.slice(from));
  return m ? from + m.index : -1;
}

type Span = { type: Measured; start: number; end: number; value: string; frag: string; cands: [number, number][] };

/** Ровно то же чтение разметки, что и в score.ts (строки 131-183). */
function spansOf(a: Ann | undefined, text: string): { spans: Span[]; dropped: number; dup: number; total: number } {
  const out: Span[] = [];
  const seen = new Set<string>();
  const usedFrom = new Map<string, number>();
  let dropped = 0, dup = 0, total = 0;
  for (const f of a?.находки ?? []) {
    const type = norm(f.тип);
    if (!type) continue;
    total += 1;
    const value = (f.значение ?? "").trim();
    const frag = (f.фрагмент ?? "").trim();
    if (!value) { dropped += 1; continue; }
    const from = usedFrom.get(value) ?? 0;
    const cands: [number, number][] = [];
    const fragAt = frag ? findFlexible(text, frag, 0) : -1;
    if (fragAt >= 0) {
      const to = fragAt + frag.length + 40;
      for (let p = fragAt; p < to; ) {
        const at = findFlexible(text.slice(0, to), value, p);
        if (at < 0) break;
        cands.push([at, at + value.length]);
        p = at + 1;
      }
    }
    if (!cands.length) {
      const at = findFlexible(text, value, from);
      if (at >= 0) cands.push([at, at + value.length]);
    }
    if (!cands.length) { dropped += 1; continue; }
    const [start, end] = cands[0]!;
    usedFrom.set(value, end);
    const k = `${type}:${start}:${end}`;
    if (seen.has(k)) { dup += 1; continue; }
    seen.add(k);
    out.push({ type, start, end, value, frag, cands });
  }
  return { spans: out, dropped, dup, total };
}

const overlap = (x: Span, y: Span) =>
  x.cands.some(([xs, xe]) => y.cands.some(([ys, ye]) => xs < ye && ys < xe));
const identical = (x: Span, y: Span) => x.start === y.start && x.end === y.end;

type Row = { chunk_id: string; type: Measured; value: string; side: "onlyA" | "onlyB"; ctx: string };
const rows: Row[] = [];
const boundaryRows: { chunk_id: string; type: Measured; a: string; b: string; ctx: string }[] = [];

const zero = () => ({ matched: 0, exact: 0, onlyA: 0, onlyB: 0, a: 0, b: 0 });
const per: Record<Measured, ReturnType<typeof zero>> = {
  WELL: zero(), GEO_NAME: zero(), LICENSE_SUBSOIL: zero(),
};
/** Независимая проверка измерителя: то же согласие, но по мультимножеству ЗНАЧЕНИЙ куска. */
const perVal: Record<Measured, { both: number; onlyA: number; onlyB: number }> = {
  WELL: { both: 0, onlyA: 0, onlyB: 0 },
  GEO_NAME: { both: 0, onlyA: 0, onlyB: 0 },
  LICENSE_SUBSOIL: { both: 0, onlyA: 0, onlyB: 0 },
};

let statA = { dropped: 0, dup: 0, total: 0 }, statB = { dropped: 0, dup: 0, total: 0 };
let common = 0;

for (const [chunk_id, c] of chunks) {
  const a = annA.get(chunk_id), b = annB.get(chunk_id);
  if (!a || !b) continue; // сравниваем только куски, размеченные ОБЕИМИ
  common += 1;
  const ra = spansOf(a, c.text), rb = spansOf(b, c.text);
  statA = { dropped: statA.dropped + ra.dropped, dup: statA.dup + ra.dup, total: statA.total + ra.total };
  statB = { dropped: statB.dropped + rb.dropped, dup: statB.dup + rb.dup, total: statB.total + rb.total };

  for (const t of MEASURED) {
    const xs = ra.spans.filter((s) => s.type === t).sort((p, q) => p.start - q.start);
    const ys = rb.spans.filter((s) => s.type === t).sort((p, q) => p.start - q.start);
    per[t].a += xs.length; per[t].b += ys.length;

    // жадное 1:1 сопоставление: сначала точные совпадения границ, потом любые пересечения
    const takenY = new Set<number>(), takenX = new Set<number>();
    for (let i = 0; i < xs.length; i++) {
      const j = ys.findIndex((y, jj) => !takenY.has(jj) && identical(xs[i]!, y));
      if (j >= 0) { takenX.add(i); takenY.add(j); per[t].matched++; per[t].exact++; }
    }
    for (let i = 0; i < xs.length; i++) {
      if (takenX.has(i)) continue;
      const j = ys.findIndex((y, jj) => !takenY.has(jj) && overlap(xs[i]!, y));
      if (j >= 0) {
        takenX.add(i); takenY.add(j); per[t].matched++;
        boundaryRows.push({
          chunk_id, type: t, a: xs[i]!.value, b: ys[j]!.value,
          ctx: c.text.slice(Math.max(0, xs[i]!.start - 60), xs[i]!.end + 60).replace(/\s+/g, " "),
        });
      }
    }
    for (let i = 0; i < xs.length; i++) {
      if (takenX.has(i)) continue;
      per[t].onlyA++;
      rows.push({ chunk_id, type: t, value: xs[i]!.value, side: "onlyA",
        ctx: c.text.slice(Math.max(0, xs[i]!.start - 70), xs[i]!.end + 70).replace(/\s+/g, " ") });
    }
    for (let j = 0; j < ys.length; j++) {
      if (takenY.has(j)) continue;
      per[t].onlyB++;
      rows.push({ chunk_id, type: t, value: ys[j]!.value, side: "onlyB",
        ctx: c.text.slice(Math.max(0, ys[j]!.start - 70), ys[j]!.end + 70).replace(/\s+/g, " ") });
    }

    // значенческий срез (мультимножество) — не зависит от привязки к спанам
    const bag = (l: Span[]) => {
      const m = new Map<string, number>();
      for (const s of l) m.set(s.value, (m.get(s.value) ?? 0) + 1);
      return m;
    };
    const ba = bag(xs), bb = bag(ys);
    for (const [v, n] of ba) {
      const k = Math.min(n, bb.get(v) ?? 0);
      perVal[t].both += k; perVal[t].onlyA += n - k;
    }
    for (const [v, n] of bb) perVal[t].onlyB += n - Math.min(n, ba.get(v) ?? 0);
  }
}

const pct = (x: number, y: number) => (y ? Math.round((x / y) * 1000) / 10 : null);
const report = {
  кусковСравнено: common,
  разметчики: { [LABEL_A]: LABEL_A, [LABEL_B]: LABEL_B },
  чтениеРазметки: {
    [LABEL_A]: { всего: statA.total, неНайденоВТексте: statA.dropped, дубликаты: statA.dup },
    [LABEL_B]: { всего: statB.total, неНайденоВТексте: statB.dropped, дубликаты: statB.dup },
  },
  поТипам: Object.fromEntries(MEASURED.map((t) => {
    const p = per[t];
    return [t, {
      [`спанов_${LABEL_A}`]: p.a,
      [`спанов_${LABEL_B}`]: p.b,
      сошлись: p.matched,
      изНихГраницыСовпалиТочно: p.exact,
      [`только_${LABEL_A}`]: p.onlyA,
      [`только_${LABEL_B}`]: p.onlyB,
      [`${LABEL_B}_покрыла_${LABEL_A}_pct`]: pct(p.matched, p.a),
      [`${LABEL_A}_покрыла_${LABEL_B}_pct`]: pct(p.matched, p.b),
      согласиеJaccardPct: pct(p.matched, p.a + p.b - p.matched),
      точностьГраницPct: pct(p.exact, p.matched),
    }];
  })),
  поЗначениям_контроль: Object.fromEntries(MEASURED.map((t) => {
    const v = perVal[t];
    return [t, {
      обе: v.both, [`только_${LABEL_A}`]: v.onlyA, [`только_${LABEL_B}`]: v.onlyB,
      [`${LABEL_B}_покрыла_${LABEL_A}_pct`]: pct(v.both, v.both + v.onlyA),
      [`${LABEL_A}_покрыла_${LABEL_B}_pct`]: pct(v.both, v.both + v.onlyB),
    }];
  })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
rows.sort((x, y) => x.type.localeCompare(y.type) || x.chunk_id.localeCompare(y.chunk_id) || x.value.localeCompare(y.value));
writeFileSync(OUT.replace(/\.json$/, "-diff.json"), JSON.stringify(rows, null, 2), "utf8");
writeFileSync(OUT.replace(/\.json$/, "-boundary.json"), JSON.stringify(boundaryRows, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`расхождений ${rows.length} → ${OUT.replace(/\.json$/, "-diff.json")}`);
console.log(`границы разошлись у ${boundaryRows.length} пар → ${OUT.replace(/\.json$/, "-boundary.json")}`);
