/**
 * Инвариант побайтовости конвейера нормализация → детекция → восстановление.
 *
 * Утверждение под проверкой: конвейер возвращает текст ПОБАЙТОВО, ноль расхождений на
 * N миллионов знаков корпусов. Проверяется на 100% доступного корпуса (не по выборке) —
 * это сильнее любых «98,5%», потому что опровергается ОДНИМ контрпримером.
 *
 * Три проверки на каждый документ каждого корпуса:
 *   I1 — нулевая правка.    tokenizeText(text, vault, []) даёт выход === входу (строка И байты).
 *   I2 — вне спанов.        Текст между обнаруженными сущностями не меняется ни на знак
 *                            (проверка склейкой сегментов, не глазами).
 *   I3 — round-trip.        detokenizeText(tokenizeText(text).text, vault) === text побайтово,
 *                            в ОБОИХ hideMode (placeholder — прод-дефолт, surrogate — опциональный).
 *
 * Модуль де-ида берётся из ВНЕШНЕГО дерева core через --core (динамический импорт по абсолютному
 * пути): харнессы живут в proboi-privacy, код де-ида — в proboi-core(-lab)/core/src/privacy/*,
 * копировать его сюда не нужно и вредно (второй источник правды).
 *
 * Запуск:
 *   bun scripts/geo-gold/invariant.ts --core ~/projects/proboi-core-lab \
 *     --out .work/geo-gold/invariant.json
 *
 * Опционально --egress-sample N добавляет замер I1/I3 на БОЕВОМ пути egress-gate.deidentifyOutbound
 * (профиль standard) на первых N документах общего потока — полный проход этим путём не тянется
 * тем же бюджетом времени, что и основной (двойной оверхед: доп. приватность-обвязка, отдельный
 * per-call vault), поэтому он — выборка, а не 100%, и в отчёте помечен как таковой.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ─── аргументы ──────────────────────────────────────────────────────────────────────────

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function resolveHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

const CORE = resolveHome(arg("core", "~/projects/proboi-core-lab")!);
const OUT = resolveHome(arg("out", ".work/geo-gold/invariant.json")!);
const DIFFS_OUT = OUT.replace(/\.json$/, "-diffs.json");
const EGRESS_SAMPLE = Number(arg("egress-sample", "0"));
const MAX_DIFFS_PER_CHECK = 50; // репрезентативная выборка расхождений, не весь корпус целиком
const PROGRESS_EVERY = 1000;
/** Подстрока имени корпуса — для дымового прогона / точечного повтора одного корпуса. */
const ONLY = arg("only");

// ─── динамический импорт де-ид модуля из --core ────────────────────────────────────────────

const deidPath = (p: string) => join(CORE, "core/src/privacy", p);

const { entitiesForVertical } = await import(deidPath("deid/entities.ts"));
const { detectEntities } = await import(deidPath("deid/detect.ts"));
const { TokenVault } = await import(deidPath("vault.ts"));
const { tokenizeText, tokenizeEntities, detokenizeText } = await import(deidPath("components/text-deid.ts"));
const { createPlaceholderOperator, createSurrogateOperator } = await import(deidPath("deid/operators.ts"));
const { createLocalMorphAdapter } = await import(deidPath("deid/morph.ts"));
type DetectedEntity = { type: string; raw: string; index: number };

const TYPES = entitiesForVertical("geo");
const morph = createLocalMorphAdapter();
const placeholderOp = createPlaceholderOperator();
const surrogateOp = createSurrogateOperator({ morph });

// ─── корпуса ────────────────────────────────────────────────────────────────────────────

const HOME = homedir();
interface CorpusFile {
  name: string;
  path: string;
  idField: "doc_id" | "chunk_id";
}
const CORPORA: CorpusFile[] = [
  { name: "corpus/client-scans", path: join(HOME, "projects/proboi-privacy/.corpus/client-scans.jsonl"), idField: "doc_id" },
  { name: "corpus/court", path: join(HOME, "projects/proboi-privacy/.corpus/court.jsonl"), idField: "doc_id" },
  { name: "corpus/disc", path: join(HOME, "projects/proboi-privacy/.corpus/disc.jsonl"), idField: "doc_id" },
  { name: "corpus/holdout", path: join(HOME, "projects/proboi-privacy/.corpus/holdout.jsonl"), idField: "doc_id" },
  { name: "corpus/other", path: join(HOME, "projects/proboi-privacy/.corpus/other.jsonl"), idField: "doc_id" },
  { name: "corpus/rosnedra", path: join(HOME, "projects/proboi-privacy/.corpus/rosnedra.jsonl"), idField: "doc_id" },
  { name: "corpus/scans", path: join(HOME, "projects/proboi-privacy/.corpus/scans.jsonl"), idField: "doc_id" },
  { name: "corpus/texts", path: join(HOME, "projects/proboi-privacy/.corpus/texts.jsonl"), idField: "doc_id" },
  { name: "geo-gold/chunks", path: join(HOME, "projects/proboi-privacy/.work/geo-gold/chunks.jsonl"), idField: "chunk_id" },
  { name: "geo-gold/chunks-client", path: join(HOME, "projects/proboi-privacy/.work/geo-gold/chunks-client.jsonl"), idField: "chunk_id" },
  { name: "geo-coord/chunks", path: join(HOME, "projects/proboi-privacy/.work/geo-coord/chunks.jsonl"), idField: "chunk_id" },
];
// ИСКЛЮЧЕНО: .corpus/gazetteer-ru.jsonl — это справочник {name,class,code}, не корпус
// ДОКУМЕНТОВ (нет поля text, есть только короткие топонимы). Инвариант побайтовости
// осмыслен для документов, гоняющих через egress; тащить сюда справочник — не тот масштаб
// и не тот жанр текста, только раздувает счётчик знаков без доказательной силы.
// .gz-дубликаты .corpus/*.jsonl.gz пропущены — тот же текст, что и в распакованном файле.

function* readJsonlFromString(raw: string): Generator<Record<string, unknown>> {
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === "\n") {
      const line = raw.slice(start, i).trim();
      start = i + 1;
      if (!line) continue;
      try {
        yield JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* битая строка JSONL — пропускаем, не роняем весь прогон */
      }
    }
  }
}

// ─── контекст для диффов ───────────────────────────────────────────────────────────────────

function context(text: string, pos: number, radius = 80): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, pos - radius), Math.max(0, pos)),
    after: text.slice(Math.max(0, pos), pos + radius),
  };
}

/** Первая позиция, где строки расходятся (по code unit), либо -1, если совпадают. */
function firstDiffIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

interface DiffRecord {
  check: "I1" | "I2" | "I3-placeholder" | "I3-surrogate" | "EGRESS-I1" | "EGRESS-I3";
  corpus: string;
  doc_id: string;
  position: number;
  detail: string;
  before: string;
  after: string;
}

const diffs: DiffRecord[] = [];
const diffCountByCheck = new Map<string, number>();

function recordDiff(rec: DiffRecord): void {
  const n = (diffCountByCheck.get(rec.check) ?? 0) + 1;
  diffCountByCheck.set(rec.check, n);
  if (n <= MAX_DIFFS_PER_CHECK) diffs.push(rec);
}

// ─── I2: склейка сегментов между спанами ───────────────────────────────────────────────────

/**
 * Проверяет, что текст МЕЖДУ обнаруженными сущностями появляется в deid-выходе В ТОМ ЖЕ
 * ПОРЯДКЕ и БЕЗ ИЗМЕНЕНИЙ. Метод устойчив к обоим hideMode: не предполагает конкретный формат
 * замены (плейсхолдер `[TYPE_NN]` или суррогатное слово), только то, что между известными
 * сегментами原текста должно быть РОВНО ОДНА замена, а сами сегменты идут по порядку.
 * Курсор двигается только вперёд — совпадение ищем НЕ «где угодно», а начиная с текущей
 * позиции, поэтому случайный повтор фрагмента гэпа раньше по документу не даёт ложного плюса.
 */
function checkGapsPreserved(
  original: string,
  deidText: string,
  ents: DetectedEntity[],
): { ok: true } | { ok: false; gapIndex: number; gapStart: number; detail: string } {
  let cursor = 0;
  let prevEnd = 0;
  for (let k = 0; k <= ents.length; k++) {
    const gapStart = prevEnd;
    const gapEnd = k === ents.length ? original.length : ents[k]!.index;
    const gap = original.slice(gapStart, gapEnd);
    if (k < ents.length) prevEnd = ents[k]!.index + ents[k]!.raw.length;
    if (gap.length === 0) continue;
    const isLast = k === ents.length;
    if (isLast) {
      // Последний сегмент обязан идти ДО САМОГО КОНЦА — иначе после него что-то ещё
      // добавлено/потеряно, а это тоже нарушение побайтовости.
      if (!deidText.endsWith(gap) || deidText.length < cursor + gap.length) {
        return { ok: false, gapIndex: k, gapStart, detail: `хвост "${gap.slice(0, 40)}…" не найден как суффикс deid-текста` };
      }
      const foundAt = deidText.length - gap.length;
      if (foundAt < cursor) {
        return { ok: false, gapIndex: k, gapStart, detail: `хвост найден РАНЬШЕ курсора (${foundAt} < ${cursor})` };
      }
      continue;
    }
    const foundAt = deidText.indexOf(gap, cursor);
    if (foundAt === -1) {
      return { ok: false, gapIndex: k, gapStart, detail: `сегмент "${gap.slice(0, 40)}…" не найден начиная с позиции ${cursor}` };
    }
    cursor = foundAt + gap.length;
  }
  return { ok: true };
}

// ─── основной проход ───────────────────────────────────────────────────────────────────────

interface CorpusStats {
  docs: number;
  chars: number;
  i1_violations: number;
  i2_violations: number;
  i3_placeholder_violations: number;
  i3_surrogate_violations: number;
}
const perCorpus: Record<string, CorpusStats> = {};
let totalDocs = 0;
let totalChars = 0;
let egressDocsChecked = 0;
let egressI1Violations = 0;
let egressI3Violations = 0;

// Опциональный боевой путь egress-gate — если поднимается без раскопок (см. шапку файла).
let deidentifyOutbound: ((text: string) => Promise<{ text: string; reidentify: (s: string) => string }>) | null = null;
if (EGRESS_SAMPLE > 0) {
  try {
    process.env.PRIVACY_PROFILE = "standard";
    const mod = await import(deidPath("egress-gate.ts"));
    deidentifyOutbound = mod.deidentifyOutbound;
    console.log(`[invariant] egress-gate.deidentifyOutbound поднялся, профиль=standard, выборка=${EGRESS_SAMPLE} документов`);
  } catch (err) {
    console.error(
      `[invariant] egress-gate НЕ поднялся без раскопок (${err instanceof Error ? err.message : String(err)}) — ` +
        `этот слой в замере НЕ покрыт, см. отчёт.`,
    );
    deidentifyOutbound = null;
  }
}

const t0 = performance.now();
let processedSinceLog = 0;

for (const corpus of CORPORA) {
  if (ONLY && !corpus.name.includes(ONLY)) continue;
  const stats: CorpusStats = { docs: 0, chars: 0, i1_violations: 0, i2_violations: 0, i3_placeholder_violations: 0, i3_surrogate_violations: 0 };
  perCorpus[corpus.name] = stats;
  let raw: string;
  try {
    raw = readFileSync(corpus.path, "utf8");
  } catch {
    console.error(`[invariant] корпус недоступен, пропущен: ${corpus.path}`);
    continue;
  }
  for (const row of readJsonlFromString(raw)) {
    const text = typeof row.text === "string" ? row.text : undefined;
    if (text === undefined) continue;
    const docId = String(row[corpus.idField] ?? row.doc_id ?? row.chunk_id ?? `line-${stats.docs}`);
    stats.docs++;
    stats.chars += text.length;
    totalDocs++;
    totalChars += text.length;

    // ── I1: нулевая правка ──
    const i1 = tokenizeText(text, new TokenVault(), []);
    const i1Ok = i1.text === text && Buffer.from(i1.text, "utf8").equals(Buffer.from(text, "utf8"));
    if (!i1Ok) {
      stats.i1_violations++;
      const pos = firstDiffIndex(text, i1.text);
      const ctx = context(text, Math.max(pos, 0));
      recordDiff({ check: "I1", corpus: corpus.name, doc_id: docId, position: pos, detail: `len ${text.length} -> ${i1.text.length}`, ...ctx });
    }

    // ── общая детекция (переиспользуется I2 и обоими режимами I3) ──
    const ents = detectEntities(text, TYPES) as DetectedEntity[];

    // ── I2: вне спанов ──
    const vaultI2 = new TokenVault();
    const deidI2 = tokenizeEntities(text, ents, vaultI2, { operator: placeholderOp, morph }).text;
    const i2 = checkGapsPreserved(text, deidI2, ents);
    if (!i2.ok) {
      stats.i2_violations++;
      const ctx = context(text, i2.gapStart);
      recordDiff({ check: "I2", corpus: corpus.name, doc_id: docId, position: i2.gapStart, detail: i2.detail, ...ctx });
    }

    // ── I3 placeholder: переиспользуем deidI2/vaultI2 (та же токенизация) ──
    const restoredPlaceholder = detokenizeText(deidI2, vaultI2);
    const i3pOk = restoredPlaceholder === text && Buffer.from(restoredPlaceholder, "utf8").equals(Buffer.from(text, "utf8"));
    if (!i3pOk) {
      stats.i3_placeholder_violations++;
      const pos = firstDiffIndex(text, restoredPlaceholder);
      const ctx = context(text, Math.max(pos, 0));
      recordDiff({ check: "I3-placeholder", corpus: corpus.name, doc_id: docId, position: pos, detail: `len ${text.length} -> ${restoredPlaceholder.length}`, ...ctx });
    }

    // ── I3 surrogate: отдельная токенизация (другой формат замены) ──
    const vaultI3s = new TokenVault();
    const deidI3s = tokenizeEntities(text, ents, vaultI3s, { operator: surrogateOp, morph }).text;
    const restoredSurrogate = detokenizeText(deidI3s, vaultI3s);
    const i3sOk = restoredSurrogate === text && Buffer.from(restoredSurrogate, "utf8").equals(Buffer.from(text, "utf8"));
    if (!i3sOk) {
      stats.i3_surrogate_violations++;
      const pos = firstDiffIndex(text, restoredSurrogate);
      const ctx = context(text, Math.max(pos, 0));
      recordDiff({ check: "I3-surrogate", corpus: corpus.name, doc_id: docId, position: pos, detail: `len ${text.length} -> ${restoredSurrogate.length}`, ...ctx });
    }

    // ── опционально: боевой путь egress-gate, профиль standard, только первые N документов ──
    if (deidentifyOutbound && egressDocsChecked < EGRESS_SAMPLE) {
      egressDocsChecked++;
      try {
        const result = await deidentifyOutbound(text);
        // I1 на этом пути осмысленно проверить нельзя без passthrough-режима (пустой профиль ->
        // fail-closed throw в egress-gate по замыслу) — здесь считаем только I3 (round-trip)
        // на профиле standard, который реально включён на проде (см. память 06.08).
        const restored = result.reidentify(result.text);
        const ok = restored === text && Buffer.from(restored, "utf8").equals(Buffer.from(text, "utf8"));
        if (!ok) {
          egressI3Violations++;
          const pos = firstDiffIndex(text, restored);
          const ctx = context(text, Math.max(pos, 0));
          recordDiff({ check: "EGRESS-I3", corpus: corpus.name, doc_id: docId, position: pos, detail: `len ${text.length} -> ${restored.length}`, ...ctx });
        }
      } catch (err) {
        egressI3Violations++;
        recordDiff({
          check: "EGRESS-I3",
          corpus: corpus.name,
          doc_id: docId,
          position: 0,
          detail: `исключение: ${err instanceof Error ? err.message : String(err)}`,
          before: "",
          after: "",
        });
      }
    }

    processedSinceLog++;
    if (processedSinceLog >= PROGRESS_EVERY) {
      processedSinceLog = 0;
      const dt = (performance.now() - t0) / 1000;
      console.log(
        `[invariant] ${totalDocs} докум., ${totalChars} зн., ${dt.toFixed(0)}с, ` +
          `${(totalChars / dt / 1e6).toFixed(2)}M зн/с — сейчас: ${corpus.name}`,
      );
    }
  }
  console.log(`[invariant] корпус готов: ${corpus.name} — ${stats.docs} докум., ${stats.chars} зн.`);
}

// ─── итог ───────────────────────────────────────────────────────────────────────────────

const dtTotal = (performance.now() - t0) / 1000;
const totals = {
  i1_violations: Object.values(perCorpus).reduce((s, c) => s + c.i1_violations, 0),
  i2_violations: Object.values(perCorpus).reduce((s, c) => s + c.i2_violations, 0),
  i3_placeholder_violations: Object.values(perCorpus).reduce((s, c) => s + c.i3_placeholder_violations, 0),
  i3_surrogate_violations: Object.values(perCorpus).reduce((s, c) => s + c.i3_surrogate_violations, 0),
};

const report = {
  meta: {
    ranAt: new Date().toISOString(),
    core: CORE,
    entityTypes: TYPES,
    corpora: CORPORA.map((c) => c.name),
    excluded: ["corpus/gazetteer-ru.jsonl (справочник {name,class,code}, не документы)"],
    durationSec: Number(dtTotal.toFixed(1)),
    egress: {
      attempted: EGRESS_SAMPLE > 0,
      available: deidentifyOutbound !== null,
      sampleRequested: EGRESS_SAMPLE,
      sampleActual: egressDocsChecked,
      i3_violations: egressI3Violations,
    },
  },
  totals: {
    documents: totalDocs,
    characters: totalChars,
    ...totals,
    // Полный диагноз "инвариант держится" ТОЛЬКО если все четыре счётчика — 0.
    allInvariantsHold:
      totals.i1_violations === 0 &&
      totals.i2_violations === 0 &&
      totals.i3_placeholder_violations === 0 &&
      totals.i3_surrogate_violations === 0,
  },
  perCorpus,
  diffCountByCheck: Object.fromEntries(diffCountByCheck),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
writeFileSync(DIFFS_OUT, JSON.stringify(diffs, null, 2), "utf8");

console.log("");
console.log(`=== ИТОГ (${dtTotal.toFixed(0)}с) ===`);
console.log(`документов: ${totalDocs}, знаков: ${totalChars}`);
console.log(`I1 (нулевая правка):        ${totals.i1_violations} расхождений`);
console.log(`I2 (вне спанов):            ${totals.i2_violations} расхождений`);
console.log(`I3 (round-trip, placeholder): ${totals.i3_placeholder_violations} расхождений`);
console.log(`I3 (round-trip, surrogate):   ${totals.i3_surrogate_violations} расхождений`);
if (EGRESS_SAMPLE > 0) {
  console.log(`EGRESS I3 (профиль standard, выборка ${egressDocsChecked}/${EGRESS_SAMPLE}): ${egressI3Violations} расхождений`);
}
console.log(`отчёт → ${OUT}`);
console.log(`диффы  → ${DIFFS_OUT}`);
