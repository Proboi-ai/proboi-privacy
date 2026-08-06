/**
 * Шаг 2: НЕЗАВИСИМАЯ разметка кусков по COORD. Сущность описана ЧЕЛОВЕЧЕСКИМИ СЛОВАМИ —
 * ни одного нашего шаблона в промпте нет: ни знака градуса, ни разделителей, ни «X=/Y=»,
 * ни слов-маркеров, по которым детектор принимает голую пару. Иначе замер станет
 * циркулярным: детектор померяется сам о себя и покажет 100 % на бумаге.
 *
 * Модель — Gemini через ШЛЮЗ AIgate (`api.aigate.shop`), тот же, которым ходит боевой чат:
 * у него свой счёт. Прямой ключ OpenRouter для опытов НЕ берём — это общий кошелёк прода,
 * и лабораторный прогон по нему 05.08 выключил клиенту распознавание сканов.
 *
 * ⚠️ `response_format: json_object` шлюз ломает у Gemini (400/502), поэтому формат ответа
 * задаётся только промптом, а ответ чистится от возможных ``` перед разбором.
 *
 *   AIGATE_API_KEY=… bun scripts/geo-coord/annotate.ts \
 *     --chunks .work/geo-coord/chunks.jsonl --out .work/geo-coord/ann.jsonl [--limit 5]
 *
 * Дописывает в --out, уже размеченные chunk_id пропускает: прогон можно рвать и продолжать.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const CHUNKS = arg("chunks", ".work/geo-coord/chunks.jsonl")!;
const OUT = arg("out", ".work/geo-coord/ann.jsonl")!;
const MODEL = arg("model", "google/gemini-3.1-pro-preview")!;
const LIMIT = Number(arg("limit", "0"));
const CONC = Number(arg("conc", "8"));
const BASE = arg("base", process.env.AIGATE_BASE_URL ?? "https://api.aigate.shop")!;
const KEY = process.env.AIGATE_API_KEY;
if (!KEY) throw new Error("нет AIGATE_API_KEY");

/**
 * Описание сущности намеренно бытовое: «где это на земле». Ни слова о том, КАК запись
 * выглядит у нас в правилах. Отдельный список «что координатой НЕ является» нужен не для
 * точности детектора, а чтобы разбор глазами потом не тонул в азимутах и отметках высот —
 * они и правда стоят рядом с координатами в каждом буровом журнале.
 */
const PROMPT = `Ты — геолог-редактор. Ниже фрагмент российского документа: геологический отчёт, буровой журнал, проект геологоразведочных работ, конкурсная документация или извещение о торгах на участок недр. Текст может быть выходом распознавания скана — с опечатками, разорванными таблицами, лишними пробелами и переносами.

Выпиши ВСЕ числовые значения, которые говорят, ГДЕ НА ЗЕМЛЕ находится объект, — то есть по которым точку можно поставить на карте:

- широта и долгота — угловая привязка к земному шару, хоть в градусах с минутами и секундами, хоть числом с дробной частью;
- прямоугольные (проекционные) координаты в метрах — так задают положение точки в маркшейдерских и буровых журналах, в каталогах угловых точек участка, на планах и разрезах.

НЕ выписывай:
- азимуты, дирекционные углы, углы наклона, падения, простирания — это направление, а не место;
- абсолютные отметки высот, глубины, мощности, интервалы, расстояния, пикеты, диаметры;
- номенклатуру листов карты (например «Р-55-69», «М-53-XIII») и масштаб («1:50 000»);
- температуры, содержания, объёмы, проценты, площади, денежные суммы;
- номера скважин, лицензий, документов, даты, телефоны.

Правила:
- Каждое ЧИСЛО выписывай ОТДЕЛЬНОЙ записью: широту отдельно от долготы, первую координату отдельно от второй. Пара — это две записи, а не одна.
- Каждое ВХОЖДЕНИЕ — отдельная запись, даже если то же значение уже встречалось выше.
- Поле «значение» — минимальный дословный кусок текста: само число со всеми знаками, которые к нему относятся, но без соседних слов.
- Поле «фрагмент» — дословный кусок исходного текста длиной 30–80 знаков, внутри которого целиком лежит значение. По нему находят место, поэтому переписывать его нужно ЗНАК В ЗНАК, вместе с опечатками, знаками препинания и разделителями таблицы.
- Ничего не додумывай и не исправляй. Если сомневаешься, что число говорит о месте на земле, — не выписывай.
- Если однотипных вхождений очень много (длинная таблица), выпиши первые 60 и добавь "обрезано": true.

Ответ — ТОЛЬКО JSON, без пояснений:
{"находки":[{"тип":"COORD","значение":"...","фрагмент":"..."}],"обрезано":false}

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

async function ask(text: string): Promise<{ raw: string; usage: unknown }> {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: PROMPT + text }],
      max_tokens: 16000,
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

let idx = 0, ok = 0, fail = 0, found = 0, cost = 0;
async function worker(w: number) {
  while (true) {
    const i = idx++;
    if (i >= todo.length) return;
    const c = todo[i]!;
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { raw, usage } = await ask(c.text);
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        const items = Array.isArray(parsed?.находки) ? parsed.находки : [];
        appendFileSync(
          OUT,
          JSON.stringify({ chunk_id: c.chunk_id, model: MODEL, находки: items, обрезано: !!parsed?.обрезано, usage }) + "\n",
        );
        ok++; found += items.length; lastErr = "";
        cost += Number((usage as { cost_usd?: number } | undefined)?.cost_usd ?? 0);
        if (ok % 10 === 0 || LIMIT) {
          console.log(`  [${w}] ${ok}/${todo.length} готово, находок всего ${found}, потрачено $${cost.toFixed(3)}`);
        }
        break;
      } catch (e: any) {
        lastErr = String(e?.message ?? e).slice(0, 140);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    if (lastErr) { fail++; console.log(`  ПРОВАЛ ${c.chunk_id}: ${lastErr}`); }
  }
}

await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i + 1)));
console.log(`\nразмечено ${ok}, провалов ${fail}, находок ${found}, потрачено $${cost.toFixed(3)} → ${OUT}`);
