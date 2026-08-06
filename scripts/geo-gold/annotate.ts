/**
 * Шаг 2: НЕЗАВИСИМАЯ разметка кусков. Модель описывает сущности человеческими словами —
 * ни одной нашей регулярки в промпте нет, иначе замер станет циркулярным (детектор
 * померяется сам о себя, ровно та ловушка, что записана в хендоффе про «градусы+минуты»).
 *
 * Модель — Gemini через ШЛЮЗ AIgate (`api.aigate.shop`), тот же, которым ходит боевой чат:
 * у него свой счёт и каталог из 65 моделей, а прямой ключ OpenRouter — общий кошелёк прода,
 * и лабораторный прогон по нему выключает клиенту распознавание сканов (05.08 так и вышло).
 * Семейство модели намеренно НЕ то, в котором потом разбирают результат.
 *
 * ⚠️ `response_format: json_object` шлюз ломает у Gemini (400/502), поэтому формат ответа
 * задаётся только промптом, а ответ чистится от возможных ``` перед разбором.
 *
 *   AIGATE_API_KEY=… bun scripts/geo-gold/annotate.ts \
 *     --chunks .work/geo-gold/chunks.jsonl --out .work/geo-gold/ann.jsonl [--limit 5]
 *
 * Дописывает в --out, уже размеченные chunk_id пропускает: прогон можно рвать и продолжать.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const CHUNKS = arg("chunks", ".work/geo-gold/chunks.jsonl")!;
const OUT = arg("out", ".work/geo-gold/ann.jsonl")!;
const MODEL = arg("model", "google/gemini-3.1-pro-preview")!;
const LIMIT = Number(arg("limit", "0"));
const CONC = Number(arg("conc", "8"));
const BUDGET = Number(arg("budget", "0")); // $ потолок; 0 = без ограничения (старое поведение)

/**
 * `--provider gonka` — калибровочная ветка (06.08): та же разметка, но бесплатной сетью Gonka.
 * Поведение по умолчанию (AIgate/Gemini) не меняется ни на байт: вся развилка — ниже по коду
 * через `IS_GONKA`. Шлюзы берутся из $COUNCIL_GATEWAYS (JSON-массив), ключ у каждого свой и
 * между шлюзами не переносится, поэтому при отказе меняем ПАРУ base+key целиком.
 *
 * ⚠️ У Gonka `response_format: json_object` тоже не работает — шлюз висит и отдаёт 524
 * (проверено живым вызовом). Формат задаётся только промптом, как и у Gemini.
 * ⚠️ Kimi — рассуждающая модель: подмешивает в поток осколки `</think>` и ``` вокруг JSON,
 * поэтому для неё чистка ответа толерантнее (вырезаем первый сбалансированный объект).
 */
const PROVIDER = arg("provider", "aigate")!;
const IS_GONKA = PROVIDER === "gonka";
type Gate = { baseUrl: string; key: string; label: string };
const GATES: Gate[] = IS_GONKA
  ? (JSON.parse(process.env.COUNCIL_GATEWAYS ?? "[]") as Gate[])
  : [];
if (IS_GONKA && !GATES.length) throw new Error("нет $COUNCIL_GATEWAYS — сделай `source ~/.claude/skills/model-council/gonka.env`");

const BASE = arg("base", process.env.AIGATE_BASE_URL ?? "https://api.aigate.shop")!;
const KEY = process.env.AIGATE_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!KEY && !IS_GONKA) throw new Error("нет AIGATE_API_KEY (или OPENROUTER_API_KEY)");

const PROMPT = `Ты — геолог-редактор. Ниже фрагмент российского документа: геологический отчёт, проект геологоразведочных работ, конкурсная документация или извещение о торгах на участок недр. Текст может быть выходом распознавания скана — с опечатками, разорванными таблицами, лишними пробелами.

Выпиши ВСЕ вхождения трёх видов сведений.

1. WELL — обозначение КОНКРЕТНОЙ скважины: её номер или шифр. Примеры того, что это: «4-Р», «№ 12», «С-5», «Х-3132», «33/2», «1-бис». Считается любое упоминание, включая строки таблицы, где слово «скважина» стоит только в шапке столбца или вовсе в заголовке таблицы.
   НЕ считается: количество скважин («пробурено 7 скважин»), глубина, отметка устья, диаметр, дебит, любые метры, проценты и денежные суммы.

2. GEO_NAME — собственное имя объекта, по которому можно показать на карте МЕСТО РАБОТ с точностью до участка: имя месторождения, рудопроявления, участка недр, площади, залежи, рудного поля, лицензионного участка, а также название реки, ручья, озера, урочища, горы, хребта.
   НЕ считается: административные единицы (область, край, район, городской округ, город, посёлок, село, улица), страны, названия организаций и их филиалов, фамилии людей, названия геологических свит/горизонтов/комплексов/пород, названия документов, программ и приборов.
   НЕ считается и крупная региональная структура — «Сибирская платформа», «Балтийский щит», «Западно-Сибирская плита», синеклизы, антеклизы, прогибы, нефтегазоносные провинции и бассейны: это масштаб региона, а не место работ.

3. LICENSE — номер лицензии на пользование недрами. Обычная запись: три буквы, пять-шесть цифр, две буквы — «ЯКУ 12345 НР», «БЛГ № 01234 ТЭ», «ИРК 02345 БР».

Правила:
- Каждое ВХОЖДЕНИЕ — отдельная запись, даже если то же значение уже встречалось выше.
- Поле «значение» — минимальный дословный кусок текста: сам номер или само имя, без слов «скважина», «месторождение», «лицензия».
- Поле «фрагмент» — дословный кусок исходного текста длиной 30–80 знаков, внутри которого целиком лежит значение. По нему находят место, поэтому переписывать его нужно ЗНАК В ЗНАК, вместе с опечатками и знаками препинания.
- Ничего не додумывай и не исправляй. Если сомневаешься, что это сущность, — не выписывай.
- Если однотипных вхождений очень много (длинная таблица), выпиши первые 60 и добавь "обрезано": true.

Ответ — ТОЛЬКО JSON, без пояснений:
{"находки":[{"тип":"WELL|GEO_NAME|LICENSE","значение":"...","фрагмент":"..."}],"обрезано":false}

ФРАГМЕНТ ДОКУМЕНТА:
`;

type Chunk = { chunk_id: string; text: string };
const chunks = readFileSync(CHUNKS, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Chunk);

mkdirSync(dirname(OUT), { recursive: true });
const done = new Set<string>();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, "utf8").split("\n")) {
    if (l.trim()) try { done.add(JSON.parse(l).chunk_id); } catch { /* битая строка */ }
  }
}
const todo = chunks.filter((c) => !done.has(c.chunk_id)).slice(0, LIMIT || undefined);
console.log(`к разметке: ${todo.length} (готово ${done.size}), модель ${MODEL}`);

/** Номер шлюза Gonka по кругу: если один умер, следующая попытка уходит на соседний. */
let gateIdx = 0;

async function ask(text: string, attempt: number): Promise<{ raw: string; usage: unknown }> {
  const gate = IS_GONKA ? GATES[(gateIdx + attempt - 1) % GATES.length]! : null;
  const url = gate ? `${gate.baseUrl}/chat/completions` : `${BASE}/v1/chat/completions`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${gate ? gate.key : KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: PROMPT + text }],
      max_tokens: 16000,
      temperature: 0,
      // Без стрима Gonka НЕПРИГОДНА: Kimi думает по 3-4 тысячи токенов на кусок и отвечает
      // ~190 с, а перед шлюзом стоит Cloudflare со 100-секундным потолком — целый ответ
      // приходит как 524 «A timeout occurred». Поток держит соединение живым и доезжает.
      ...(IS_GONKA ? { stream: true } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}${gate ? ` @${gate.label}` : ""}: ${(await r.text()).slice(0, 200)}`);

  if (IS_GONKA) {
    let buf = "", content = "", usage: unknown = null;
    const dec = new TextDecoder();
    for await (const part of r.body as any as AsyncIterable<Uint8Array>) {
      buf += dec.decode(part, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const d = t.slice(5).trim();
        if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d);
          content += j.choices?.[0]?.delta?.content ?? "";
          if (j.usage) usage = j.usage;
        } catch { /* осколок SSE — соберётся на следующем чанке */ }
      }
    }
    if (!content.trim()) throw new Error(`пустой поток @${gate!.label}`);
    return { raw: content, usage };
  }

  const j = (await r.json()) as any;
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error(`пустой ответ: ${JSON.stringify(j).slice(0, 200)}`);
  return { raw: content, usage: j.usage };
}

/**
 * Вырезать первый сбалансированный JSON-объект. Нужно только рассуждающим моделям Gonka:
 * Kimi отдаёт вида ` ``` </think> {...}\n``` `, и старая чистка ```-обёртки на этом ломается.
 * Скобки считаем с учётом строк и экранирования — иначе `{` внутри «фрагмента» рвёт разбор.
 */
function carveJson(raw: string): string {
  const s = raw.indexOf("{");
  if (s < 0) throw new Error(`в ответе нет JSON: ${raw.slice(0, 120)}`);
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < raw.length; i++) {
    const ch = raw[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return raw.slice(s, i + 1);
  }
  throw new Error(`JSON оборван (depth ${depth}): ${raw.slice(-120)}`);
}

let idx = 0, ok = 0, fail = 0, found = 0, cost = 0, budgetStopped = false;
/** Диагностика калибровки: сколько времени реально ест вызов и сколько попыток срывается. */
const lat: number[] = [];
let retries = 0;
const errKinds: Record<string, number> = {};
async function worker(w: number) {
  while (true) {
    if (BUDGET > 0 && cost >= BUDGET) {
      if (!budgetStopped) {
        budgetStopped = true;
        console.log(`\nПОТОЛОК БЮДЖЕТА $${BUDGET} достигнут (потрачено $${cost.toFixed(3)}) — останавливаю набор новых кусков.`);
      }
      return;
    }
    const i = idx++;
    if (i >= todo.length) return;
    const c = todo[i]!;
    let lastErr = "";
    const MAX = IS_GONKA ? 5 : 3; // сеть Gonka флапает чаще платного шлюза — попыток больше
    for (let attempt = 1; attempt <= MAX; attempt++) {
      const t0 = Date.now();
      try {
        const { raw, usage } = await ask(c.text, attempt);
        const parsed = JSON.parse(
          IS_GONKA ? carveJson(raw) : raw.replace(/^```(?:json)?\s*|\s*```$/g, ""),
        );
        const items = Array.isArray(parsed?.находки) ? parsed.находки : [];
        appendFileSync(
          OUT,
          JSON.stringify({ chunk_id: c.chunk_id, model: MODEL, находки: items, обрезано: !!parsed?.обрезано, usage }) + "\n",
        );
        ok++; found += items.length; lastErr = "";
        lat.push((Date.now() - t0) / 1000);
        cost += Number(
          (usage as { cost_usd?: number; total_cost_usd?: number } | undefined)?.cost_usd ??
            (usage as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0,
        );
        if (ok % 10 === 0 || LIMIT) {
          console.log(`  [${w}] ${ok}/${todo.length} готово, находок всего ${found}, потрачено $${cost.toFixed(3)}`);
        }
        break;
      } catch (e: any) {
        lastErr = String(e?.message ?? e).slice(0, 140);
        retries += 1;
        const kind = /HTTP (\d+)/.exec(lastErr)?.[0] ?? (/timed out|timeout/i.test(lastErr) ? "timeout" : /JSON|нет JSON|оборван/.test(lastErr) ? "разбор" : "прочее");
        errKinds[kind] = (errKinds[kind] ?? 0) + 1;
        if (attempt < MAX) await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    if (lastErr) { fail++; console.log(`  ПРОВАЛ ${c.chunk_id}: ${lastErr}`); }
  }
}

const startedAt = Date.now();
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i + 1)));
const wall = (Date.now() - startedAt) / 1000;
lat.sort((a, b) => a - b);
console.log(`\nразмечено ${ok}, провалов ${fail}, находок ${found}, потрачено $${cost.toFixed(3)} → ${OUT}`);
console.log(
  `стена ${wall.toFixed(0)} с при conc=${CONC}; вызов med ${(lat[Math.floor(lat.length / 2)] ?? 0).toFixed(1)} с, ` +
    `p90 ${(lat[Math.floor(lat.length * 0.9)] ?? 0).toFixed(1)} с, max ${(lat.at(-1) ?? 0).toFixed(1)} с; ` +
    `сорванных попыток ${retries} ${JSON.stringify(errKinds)}`,
);
