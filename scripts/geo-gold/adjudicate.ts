/**
 * Слепой разбор эталонной разметки (шаг между разметкой и `score.ts`).
 *
 * ⚠️ ГЛАВНОЕ СВОЙСТВО ЭТОГО ФАЙЛА — НЕЗАВИСИМОСТЬ ОТ ДЕТЕКТОРА. Разбор решает один вопрос:
 * «лежит ли то, что независимая разметка назвала сущностью, В ГРАНИЦАХ ПРОДУКТА» — то есть
 * стоит ли это вообще маскировать. Это вопрос ПРАВИЛА (см. ключи "_*" в `--known`), а не
 * вопрос «нашёл ли детектор». Поэтому здесь НЕТ и не должно быть:
 *   - импорта чего-либо из core/src/privacy/ (или любого другого детектора);
 *   - чтения `*-misses.json`, `*-unconfirmed.json`, `*-gold.json`, `score*.json` или похожих
 *     файлов боевого замера.
 * Если разбор увидит, что детектор что-то пропустил, у него появится соблазн одним движением
 * объявить пропуск «шумом» — и метрика полноты превратится во вранье в пользу «детектор
 * хороший». Ловушка ровно та же, что и с моделью-аннотатором в `annotate.ts`: судья должен
 * быть слеп к тому, что меряют, иначе измерение меряет само себя.
 *
 * Что делает скрипт:
 *   1. Собирает из `--ann` все УНИКАЛЬНЫЕ пары (тип, значение), для каждой — число вхождений
 *      и до 3 примеров контекста (±120 знаков вокруг вхождения в исходном тексте куска из
 *      `--chunks`; вхождение ищется через фрагмент, который вернула разметка).
 *   2. Пары, вердикт по которым уже есть в `--known`, НЕ пересматривает — переносит как есть.
 *   3. Остальные пары пачками отправляет судье-модели: ей передаётся ДОСЛОВНО текст правила
 *      из всех ключей `--known`, начинающихся на "_", — в старом (05.08) разборе это был
 *      один ключ `"_"`, в COORD-разборе правило разложено на несколько `"_методика"`,
 *      `"_семь_спорных"` и т.п. — берём их все и склеиваем, дословно, ничего не добавляя.
 *   4. Судья — ДРУГАЯ роль, чем аннотатор (`annotate.ts` отвечал «есть ли здесь сущность»,
 *      этот промпт отвечает «в границах ли продукта то, что аннотатор уже нашёл»), с ОТДЕЛЬНЫМ
 *      промптом.
 *   5. Пишет результат в формате, которым питается `score.ts`: если `--known` был вложенным
 *      по типу ({ТИП: {значение: вердикт}}, как у geo-gold) — итог тоже вложенный; если плоским
 *      ({значение: вердикт}, как у geo-coord, там всего один тип) — итог тоже плоский. Формат
 *      определяется по форме `--known`, а не зашит в код: один скрипт обслуживает оба замера.
 *      Обоснования (для проверки глазами) уходят в отдельный `<out>-why.json` — `score.ts` их
 *      не ждёт.
 *   6. Резюмируемо: прогресс пишется построчно в `<out>-progress.jsonl` по ходу дела; повторный
 *      запуск подхватывает уже разобранные пары и не платит за них снова.
 *
 * Деньги и канал — как у `annotate.ts`: ТОЛЬКО через AIgate (`https://api.aigate.shop`),
 * прямой ключ OpenRouter не берём — общий кошелёк живого клиента. `response_format:
 * json_object` шлюз ломает у Gemini, формат ответа задаём только промптом и чистим от ```.
 *
 *   AIGATE_API_KEY=… bun scripts/geo-gold/adjudicate.ts \
 *     --ann .work/geo-gold/ann-holdout.jsonl --chunks .work/geo-gold/chunks-holdout.jsonl \
 *     --known scripts/geo-gold/adjudication.json --out scripts/geo-gold/adjudication-holdout.json
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const ANN = arg("ann")!;
const CHUNKS = arg("chunks")!;
const KNOWN = arg("known")!;
const OUT = arg("out")!;
const MODEL = arg("model", "google/gemini-3.1-pro-preview")!;
const BATCH = Number(arg("batch", "20"));
const CONC = Number(arg("conc", "4"));
const LIMIT = Number(arg("limit", "0"));
const BASE = arg("base", process.env.AIGATE_BASE_URL ?? "https://api.aigate.shop")!;
const KEY = process.env.AIGATE_API_KEY;
if (!ANN || !CHUNKS || !KNOWN || !OUT) {
  throw new Error("нужны --ann --chunks --known --out");
}
if (!KEY) throw new Error("нет AIGATE_API_KEY");

const PROGRESS = OUT.replace(/\.json$/, "-progress.jsonl");
const WHY = OUT.replace(/\.json$/, "-why.json");

// ── 1. читаем куски и разметку ────────────────────────────────────────────────────────────
type ChunkRec = { chunk_id: string; text: string };
const chunkText = new Map<string, string>();
for (const l of readFileSync(CHUNKS, "utf8").split("\n")) {
  if (!l.trim()) continue;
  const c = JSON.parse(l) as ChunkRec;
  chunkText.set(c.chunk_id, c.text);
}

type Finding = { тип: string; значение: string; фрагмент: string };
type AnnRec = { chunk_id: string; находки: Finding[] };
const annRecs: AnnRec[] = readFileSync(ANN, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as AnnRec);

/** Ищем с допуском по пробелам: разметка переносит текст, таблицы полны неразрывных пробелов. */
function findFlexible(hay: string, needle: string, from = 0): number {
  const direct = hay.indexOf(needle, from);
  if (direct >= 0) return direct;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "u");
  const m = re.exec(hay.slice(from));
  return m ? from + m.index : -1;
}

/** Находим вхождение значения рядом с фрагментом, который дала разметка (или где угодно). */
function locate(text: string, value: string, frag: string): [number, number] | null {
  const fragAt = frag ? findFlexible(text, frag, 0) : -1;
  if (fragAt >= 0) {
    const windowEnd = Math.min(text.length, fragAt + frag.length + 40);
    const at = findFlexible(text.slice(0, windowEnd), value, fragAt);
    if (at >= 0) return [at, at + value.length];
  }
  const at2 = findFlexible(text, value, 0);
  return at2 >= 0 ? [at2, at2 + value.length] : null;
}

const contextAround = (text: string, start: number, end: number): string =>
  text
    .slice(Math.max(0, start - 120), Math.min(text.length, end + 120))
    .replace(/\s+/g, " ")
    .trim();

/** "LICENSE" (как пишет annotate.ts) ↔ "LICENSE_SUBSOIL" (как ключ в adjudication.json). */
const normalizeType = (t: string): string | null => {
  const v = (t ?? "").trim();
  if (!v) return null;
  return v === "LICENSE" ? "LICENSE_SUBSOIL" : v;
};

type PairInfo = { type: string; value: string; occurrences: number; contexts: string[] };
const pairs = new Map<string, PairInfo>();
const pairKey = (type: string, value: string) => `${type}${value}`;

for (const rec of annRecs) {
  const text = chunkText.get(rec.chunk_id);
  for (const f of rec.находки ?? []) {
    const type = normalizeType(f.тип);
    if (!type) continue;
    const value = (f.значение ?? "").trim();
    if (!value) continue;
    const k = pairKey(type, value);
    let info = pairs.get(k);
    if (!info) {
      info = { type, value, occurrences: 0, contexts: [] };
      pairs.set(k, info);
    }
    info.occurrences += 1;
    if (info.contexts.length < 3 && text) {
      const loc = locate(text, value, (f.фрагмент ?? "").trim());
      if (loc) {
        const ctx = contextAround(text, loc[0], loc[1]);
        if (ctx && !info.contexts.includes(ctx)) info.contexts.push(ctx);
      }
    }
  }
}

// ── 2. известные вердикты + текст правила ─────────────────────────────────────────────────
const known: Record<string, unknown> = JSON.parse(readFileSync(KNOWN, "utf8"));

const nonMeta = Object.entries(known).filter(([k]) => !k.startsWith("_"));
let nested: boolean;
if (nonMeta.length > 0) {
  const [, v] = nonMeta[0]!;
  nested = typeof v === "object" && v !== null && !Array.isArray(v);
} else {
  // --known ещё не содержит ни одного вердикта (случай geo-coord 06.08: "отклонять
  // оказалось нечего") — определяем форму по числу различных типов в самой разметке.
  nested = new Set([...pairs.values()].map((p) => p.type)).size > 1;
}

function knownVerdict(type: string, value: string): string | undefined {
  if (nested) {
    const bucket = known[type] as Record<string, string> | undefined;
    return bucket?.[value];
  }
  const v = known[value];
  return typeof v === "string" ? v : undefined;
}

const ruleText = Object.entries(known)
  .filter(([k]) => k.startsWith("_"))
  .flatMap(([, v]) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []))
  .join("\n");
if (!ruleText.trim()) throw new Error(`в ${KNOWN} нет ни одного ключа "_*" с текстом правила`);

// ── 3. прогресс (резюмируемость) ──────────────────────────────────────────────────────────
type Verdict = "in" | "out" | "noise";
const progress = new Map<string, { вердикт: Verdict; обоснование: string }>();
if (existsSync(PROGRESS)) {
  for (const l of readFileSync(PROGRESS, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      progress.set(pairKey(r.тип, r.значение), { вердикт: r.вердикт, обоснование: r.обоснование });
    } catch {
      /* битая строка прогресса — пропускаем, она просто будет пересужена */
    }
  }
}

const todo: PairInfo[] = [];
let carried = 0;
for (const info of pairs.values()) {
  if (knownVerdict(info.type, info.value) !== undefined) {
    carried += 1;
    continue;
  }
  if (progress.has(pairKey(info.type, info.value))) continue;
  todo.push(info);
}
const todoLimited = LIMIT ? todo.slice(0, LIMIT) : todo;

console.log(
  `пар всего ${pairs.size}, перенесено из известного разбора ${carried}, ` +
    `уже разобрано в прошлых прогонах ${pairs.size - carried - todo.length}, к разбору сейчас ${todoLimited.length}`,
);

// ── 4. судья-модель: ДРУГАЯ роль, чем аннотатор ───────────────────────────────────────────
const JUDGE_INTRO = `Ты — судья-ревизор эталонной разметки для продукта деидентификации геологических документов (152-ФЗ). Другая модель (аннотатор) уже прочитала фрагменты текста и выписала оттуда значения, которые она сочла сущностями нужного типа. Твоя роль — ДРУГАЯ: ты не ищешь сущности заново и не проверяешь, правильно ли аннотатор прочитал текст. Твоя задача — для каждого уже найденного значения решить, лежит ли ОНО САМО в границах продукта (то есть должно ли оно маскироваться) или нет, строго по правилу ниже.`;

function buildPrompt(batch: PairInfo[]): string {
  const items = batch
    .map((p, i) => {
      const ctx = p.contexts.length
        ? p.contexts.map((c, j) => `     контекст ${j + 1}: «${c}»`).join("\n")
        : "     контекст: (не нашёлся в тексте куска, суди по значению и типу)";
      return `${i + 1}. тип: ${p.type}; значение: «${p.value}»; вхождений в разметке: ${p.occurrences}\n${ctx}`;
    })
    .join("\n\n");
  return `${JUDGE_INTRO}

ПРАВИЛО (дословно; применяй его как есть, не изобретай новых критериев):
"""
${ruleText}
"""

Вынеси вердикт по каждому пункту списка:
- in — сущность в границах продукта (см. правило);
- out — вне границ продукта (см. правило);
- noise — мусор распознавания/разметки (см. правило).

СПИСОК:

${items}

Ответ — ТОЛЬКО JSON, без пояснений вокруг, порядок пунктов ответа = порядок списка:
{"вердикты":[{"id":1,"вердикт":"in|out|noise","обоснование":"одна строка по-русски, коротко"}]}`;
}

async function ask(prompt: string): Promise<{ raw: string; usage: unknown }> {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8000,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as any;
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error(`пустой ответ: ${JSON.stringify(j).slice(0, 200)}`);
  return { raw: content, usage: j.usage };
}

const VALID_VERDICTS = new Set(["in", "out", "noise"]);

const batches: PairInfo[][] = [];
for (let i = 0; i < todoLimited.length; i += BATCH) batches.push(todoLimited.slice(i, i + BATCH));

let idx = 0,
  batchesOk = 0,
  cost = 0,
  itemsJudged = 0,
  itemsUnresolved = 0;

async function worker(w: number) {
  while (true) {
    const bi = idx++;
    if (bi >= batches.length) return;
    const batch = batches[bi]!;
    const prompt = buildPrompt(batch);
    let resolved = new Map<number, { вердикт: Verdict; обоснование: string }>();
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { raw, usage } = await ask(prompt);
        cost += Number((usage as { cost_usd?: number } | undefined)?.cost_usd ?? 0);
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        const verdicts = Array.isArray(parsed?.вердикты) ? parsed.вердикты : [];
        for (const v of verdicts) {
          const id = Number(v?.id);
          if (!Number.isInteger(id) || id < 1 || id > batch.length) continue;
          const verdict = String(v?.вердикт ?? "").trim() as Verdict;
          if (!VALID_VERDICTS.has(verdict)) continue;
          const обоснование = String(v?.обоснование ?? "").trim();
          resolved.set(id, { вердикт: verdict, обоснование });
        }
        if (resolved.size === batch.length) { lastErr = ""; break; }
        lastErr = `частично разобрано ${resolved.size}/${batch.length}`;
      } catch (e: any) {
        lastErr = String(e?.message ?? e).slice(0, 160);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }

    for (const [id, v] of resolved) {
      const p = batch[id - 1]!;
      progress.set(pairKey(p.type, p.value), v);
      appendFileSync(
        PROGRESS,
        JSON.stringify({ тип: p.type, значение: p.value, вердикт: v.вердикт, обоснование: v.обоснование }) + "\n",
      );
    }
    itemsJudged += resolved.size;
    itemsUnresolved += batch.length - resolved.size;
    batchesOk += 1;
    console.log(
      `  [${w}] пачка ${batchesOk}/${batches.length}: разобрано ${resolved.size}/${batch.length}` +
        (lastErr ? ` (остаток: ${lastErr})` : "") +
        `, потрачено $${cost.toFixed(3)}`,
    );
  }
}

if (batches.length) {
  mkdirSync(dirname(PROGRESS), { recursive: true });
  await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, (_, i) => worker(i + 1)));
}

// ── 5. финальный вывод: то, что читает score.ts, + обоснования отдельно ──────────────────
const outNested: Record<string, Record<string, string>> = {};
const outFlat: Record<string, string> = {};
const why: { тип: string; значение: string; вердикт: string; обоснование: string; вхождений: number; контекст: string }[] = [];
const dist: Record<string, number> = {};
let finalCarried = 0,
  finalJudged = 0,
  stillUnjudged = 0;

for (const info of pairs.values()) {
  const kv = knownVerdict(info.type, info.value);
  let verdict: string | undefined;
  let isNew = false;
  if (kv !== undefined) {
    verdict = kv;
    finalCarried += 1;
  } else {
    const p = progress.get(pairKey(info.type, info.value));
    if (p) {
      verdict = p.вердикт;
      isNew = true;
      finalJudged += 1;
    }
  }
  if (verdict === undefined) {
    stillUnjudged += 1;
    continue; // не разобрано в этом прогоне — попадёт в todo при следующем запуске
  }
  dist[`${info.type}:${verdict}`] = (dist[`${info.type}:${verdict}`] ?? 0) + 1;
  if (nested) {
    outNested[info.type] ??= {};
    outNested[info.type]![info.value] = verdict;
  } else {
    outFlat[info.value] = verdict;
  }
  if (isNew) {
    const p = progress.get(pairKey(info.type, info.value))!;
    why.push({
      тип: info.type,
      значение: info.value,
      вердикт: verdict,
      обоснование: p.обоснование,
      вхождений: info.occurrences,
      контекст: info.contexts[0] ?? "",
    });
  }
}

const meta = [
  `Слепой автоматический разбор пар (тип, значение) из ${ANN} против правила из ${KNOWN}.`,
  `Сгенерировано scripts/geo-gold/adjudicate.ts, судья ${MODEL} через AIgate, ${new Date().toISOString()}.`,
  `Скрипт НЕ видел находки/пропуски боевого детектора — только независимую разметку и текст правила (см. шапку файла).`,
  `Пар всего ${pairs.size}: перенесено без пересмотра из известного разбора ${finalCarried}, разобрано заново ${finalJudged}` +
    (stillUnjudged ? `, НЕ разобрано (повторить прогон) ${stillUnjudged}` : "") +
    ".",
];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(nested ? { ...outNested, _: meta } : { ...outFlat, _: meta }, null, 2) + "\n", "utf8");
writeFileSync(WHY, JSON.stringify(why, null, 2) + "\n", "utf8");

console.log(`\nформат вывода: ${nested ? "вложенный по типу" : "плоский (один тип)"}`);
console.log(`распределение вердиктов: ${JSON.stringify(dist)}`);
console.log(`перенесено ${finalCarried}, разобрано заново ${finalJudged}, не разобрано ${stillUnjudged}`);
console.log(`потрачено на эту сессию $${cost.toFixed(3)}`);
console.log(`→ ${OUT}`);
console.log(`→ ${WHY} (обоснования, ${why.length} строк)`);
if (stillUnjudged) console.log(`ВНИМАНИЕ: ${stillUnjudged} пар не разобрано — запусти скрипт ещё раз (резюмируемо).`);
