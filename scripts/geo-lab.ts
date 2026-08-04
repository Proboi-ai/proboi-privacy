/**
 * Гео-лаборатория: полнота, разбор пропусков и выборка находок за один скрипт.
 *
 * Три режима, все параллельные по ядрам (Bun однопоточный → параллелим процессами,
 * доли балансируем по ОБЪЁМУ текста: документы различаются по длине на два порядка).
 *
 *   bun geo-lab.ts measure                      — полнота по всем типам
 *   bun geo-lab.ts misses --type GEO_NAME       — что осталось открытым, по формам
 *   bun geo-lab.ts hits   --type GEO_NAME       — что детектор ЗАМАСКИРОВАЛ (для точности)
 */
import { detectEntities } from "../src/deid/detect";
import { entitiesForVertical } from "../src/deid/entities";
import { maskDetected, geoNetMatches, GEO_RECALL_TYPES } from "../src/validation-geo";

const argv = process.argv;
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const mode = argv[2] ?? "measure";
const type = arg("type", "GEO_NAME")!;

type Counts = Record<string, { найдено: number; вИсходном: number; осталось: number }>;
type Item = { value: string; ctx: string };

function runMeasure(docs: { text: string }[]): Counts {
  const types = entitiesForVertical("geo");
  const out: Counts = {};
  for (const t of GEO_RECALL_TYPES) out[t] = { найдено: 0, вИсходном: 0, осталось: 0 };
  for (const doc of docs) {
    const hits = detectEntities(doc.text, types);
    for (const e of hits) if (e.type in out) out[e.type]!.найдено += 1;
    const masked = maskDetected(doc.text, hits);
    for (const t of GEO_RECALL_TYPES) {
      out[t]!.вИсходном += geoNetMatches(t, doc.text).length;
      for (const m of geoNetMatches(t, masked)) {
        if (/\[[A-Z_]{3,}\]/.test(m.value)) continue;
        out[t]!.осталось += 1;
      }
    }
  }
  return out;
}

function runMisses(docs: { text: string }[]): Item[] {
  const types = entitiesForVertical("geo");
  const out: Item[] = [];
  for (const doc of docs) {
    const masked = maskDetected(doc.text, detectEntities(doc.text, types));
    for (const m of geoNetMatches(type as never, masked)) {
      if (/\[[A-Z_]{3,}\]/.test(m.value)) continue;
      out.push({
        value: m.value.replace(/\s+/g, " ").trim(),
        ctx: masked.slice(Math.max(0, m.index - 70), m.index + m.value.length + 70).replace(/\s+/g, " "),
      });
    }
  }
  return out;
}

function runHits(docs: { text: string }[]): Item[] {
  const types = entitiesForVertical("geo");
  const out: Item[] = [];
  for (const doc of docs) {
    for (const e of detectEntities(doc.text, types)) {
      if (e.type !== type) continue;
      out.push({
        value: e.raw.replace(/\s+/g, " ").trim(),
        ctx: doc.text.slice(Math.max(0, e.index - 70), e.index + e.raw.length + 70).replace(/\s+/g, " "),
      });
    }
  }
  return out;
}

/**
 * Кандидаты сети в ИСХОДНОМ тексте с пометкой, забрал ли их детектор.
 *
 * Зачем отдельный режим. Полнота «относительно сети» перестаёт что-либо значить, как
 * только детектор становится точнее сети: сеть считает пропуском то, что детектор
 * ПРАВИЛЬНО не трогает, и рост точности выглядит падением полноты. Поэтому эталон
 * строим руками: выгружаем формы кандидатов, размечаем их «имя / не имя» (форм десятки,
 * не тысячи), и считаем полноту только по тем, что действительно имена.
 */
function runNet(docs: { text: string }[]): Item[] {
  const types = entitiesForVertical("geo");
  const out: Item[] = [];
  for (const doc of docs) {
    const masked = maskDetected(doc.text, detectEntities(doc.text, types));
    const openTail = new Map<string, number>();
    for (const m of geoNetMatches(type as never, masked)) {
      if (/\[[A-Z_]{3,}\]/.test(m.value)) continue;
      const k = m.value.replace(/\s+/g, " ").trim().toLowerCase();
      openTail.set(k, (openTail.get(k) ?? 0) + 1);
    }
    for (const m of geoNetMatches(type as never, doc.text)) {
      const k = m.value.replace(/\s+/g, " ").trim().toLowerCase();
      const left = openTail.get(k) ?? 0;
      // Осталась ли ЭТА форма открытой хоть раз в документе: пометка на форму, не на спан.
      out.push({ value: `${left > 0 ? "ОТКРЫТО" : "закрыто"}\t${k}`, ctx: "" });
      if (left > 0) openTail.set(k, left - 1);
    }
  }
  return out;
}

const RUN = { measure: runMeasure, misses: runMisses, hits: runHits, net: runNet } as const;

// ── рабочий: считает свою долю ──
const slicePath = arg("worker");
if (slicePath) {
  const docs = (await Bun.file(slicePath).text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  console.log(JSON.stringify(RUN[mode as keyof typeof RUN](docs)));
  process.exit(0);
}

// ── ведущий ──
const textsPath = arg("texts", ".corpus/texts.jsonl")!;
const workers = Number(arg("workers", "8"));
const docs = (await Bun.file(textsPath).text())
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.text?.trim());
const chars = docs.reduce((s, d) => s + d.text.length, 0);

const slices: string[][] = Array.from({ length: workers }, () => []);
const load = new Array<number>(workers).fill(0);
for (const d of [...docs].sort((a, b) => b.text.length - a.text.length)) {
  let k = 0;
  for (let i = 1; i < workers; i++) if (load[i]! < load[k]!) k = i;
  slices[k]!.push(JSON.stringify(d));
  load[k] += d.text.length;
}

const tmp = `/tmp/geo-lab-${process.pid}`;
await Bun.write(`${tmp}/.keep`, "");
const started = Date.now();
const parts = await Promise.all(
  slices.map(async (lines, i) => {
    const p = `${tmp}/slice-${i}.jsonl`;
    await Bun.write(p, lines.join("\n"));
    const proc = Bun.spawn(["bun", import.meta.path, mode, "--worker", p, "--type", type], { stdout: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(text);
  }),
);
const secs = ((Date.now() - started) / 1000).toFixed(1);

if (mode === "measure") {
  const total: Counts = {};
  for (const t of GEO_RECALL_TYPES) total[t] = { найдено: 0, вИсходном: 0, осталось: 0 };
  for (const r of parts as Counts[]) {
    for (const t of GEO_RECALL_TYPES) {
      total[t]!.найдено += r[t]!.найдено;
      total[t]!.вИсходном += r[t]!.вИсходном;
      total[t]!.осталось += r[t]!.осталось;
    }
  }
  console.log(`документов ${docs.length}, символов ${(chars / 1e6).toFixed(1)} млн, рабочих ${workers}, время ${secs} с\n`);
  console.log("тип              находок  сеть нашла  осталось открытым  полнота");
  for (const t of GEO_RECALL_TYPES) {
    const v = total[t]!;
    const pct = v.вИсходном === 0 ? "—" : `${(100 * (1 - v.осталось / v.вИсходном)).toFixed(1)}%`;
    console.log(
      `${t.padEnd(16)} ${String(v.найдено).padStart(7)}  ${String(v.вИсходном).padStart(10)}  ` +
        `${String(v.осталось).padStart(17)}  ${pct.padStart(7)}`,
    );
  }
} else {
  const all = (parts as Item[][]).flat();
  const groups = new Map<string, { n: number; ctx: string[] }>();
  for (const m of all) {
    const key = m.value.toLowerCase();
    const g = groups.get(key) ?? { n: 0, ctx: [] };
    g.n += 1;
    if (g.ctx.length < 2) g.ctx.push(m.ctx);
    groups.set(key, g);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`${mode} ${type}: всего ${all.length}, уникальных форм ${sorted.length}, время ${secs} с\n`);
  const limit = Number(arg("limit", "120"));
  for (const [k, v] of sorted.slice(0, limit)) console.log(`${String(v.n).padStart(4)}  ${k}`);
  const outPath = arg("out");
  if (outPath) await Bun.write(outPath, JSON.stringify(sorted.map(([k, v]) => ({ форма: k, n: v.n, ctx: v.ctx })), null, 2));
}
