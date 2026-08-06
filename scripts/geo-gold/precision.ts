/**
 * ЗЕРКАЛЬНЫЙ харнесс к score.ts: меряем ТОЧНОСТЬ, а не полноту.
 *
 * `score.ts` берёт независимую разметку и смотрит, что боевой детектор ПРОПУСТИЛ (полнота).
 * Этот скрипт идёт с другого конца: берёт ВСЕ находки детектора и для каждой спрашивает
 * независимого судью — та ли это сущность и точно ли выделены границы. Эта сторона ошибки
 * не мерилась НИ РАЗУ: 05.08.2026 уже был случай, когда «92,8 %» на поверку оказались 15 %,
 * потому что смотрели только на пропуски, а не на то, что детектор реально прячет (см. память
 * `geo-precision-two-corpora-2026-08-05`). Ошибка в измерителе там стоила дороже ошибки в
 * детекторе — отсюда и это дерево: проверяем ИЗМЕРИТЕЛЬ (утки/согласие судей/смещение
 * позиции), прежде чем публиковать цифру.
 *
 * ⚠️ ПРАВИЛА ДЕТЕКТОРА (core/src/privacy/deid/*) ИЗ ЭТОГО СКРИПТА НЕ ПРАВИТЬ — идёт замер,
 * не тюнинг. ⚠️ scripts/geo-gold/adjudication-precision.json — разбор ГЛАЗАМИ отвергнутых
 * находок. Агентам, которые крутят правила детектора, ПРАВИТЬ ЭТОТ ФАЙЛ ЗАПРЕЩЕНО: один
 * `"exclude"` без разбора глазами объявляет ложняк шумом, и метрика начинает врать в пользу
 * детектора — ровно та ловушка, ради которой заведён отдельный файл `adjudication.json` для
 * полноты (см. README, «Разбор эталона глазами»).
 *
 * Судья решает задачу КЛАССИФИКАЦИИ (один из 5 вариантов, включая «ни один»), а НЕ
 * подтверждения («это скважина? да/нет») — на подтверждающий вопрос модель поддакивает.
 * Заодно судья отдельно оценивает границы выделения (exact/too_wide/too_narrow): неверные
 * границы — это реальный вред (маскируется не тот кусок документа), поэтому строгая точность
 * считается отдельно от мягкой.
 *
 * КОНВЕНЦИЯ ГРАНИЦ ПО ТИПАМ (важно понимать ПЕРЕД чтением цифры too_wide — иначе кажется,
 * что детектор режет криво, хотя он делает это по замыслу):
 *   WELL             — спан ПО ЗАМЫСЛУ включает ключевое слово-якорь до самого номера:
 *                       «скважины № 32», «скважины той же линии № 40», «скв. 5-Р». Голое
 *                       число без якоря не ловится вообще — это не дефект, это как работает
 *                       правило. Судья предупреждён об этом прямо в промпте (иначе получил бы
 *                       too_wide на КАЖДОЙ находке WELL и строгая точность вышла бы мусорной).
 *   GEO_NAME         — СМЕШАННАЯ конвенция: у форм «участок «Х»» / «месторождение «Х»» /
 *                       «река Х» ключевое слово — часть спана (как у WELL); а у находок,
 *                       закрытых протяжкой (`spreadGeoNames`) или легендой карты
 *                       (`geo-legend.ts`), спан — ГОЛОЕ имя без всякого ключа, потому что
 *                       рядом с повторным упоминанием ключа в тексте может и не быть. Оба
 *                       варианта — «exact», если больше ничего лишнего не прихвачено.
 *   LICENSE_SUBSOIL  — спан САМ КОД, БЕЗ слова «лицензия» слева («ЯКУ 12345 НР», а не
 *                       «лицензия ЯКУ 12345 НР»). Ключевое слово в спан не входит никогда.
 *   COORD            — спан ЧИСЛО (или пара чисел раздельно), без подписи «X=», «широта:» и
 *                       т. п. — она в спан COORD не включается никогда (делегировано в
 *                       core/src/privacy/geo/coords.ts).
 * Отсюда сама формулировка вопроса о границах в промпте: too_wide — только если выделение
 * ЗАЛЕЗАЕТ В ДРУГУЮ, ОТДЕЛЬНУЮ СУЩНОСТЬ (например, в номер соседней скважины) или прихватывает
 * текст, вообще не относящийся к значению; непосредственно примыкающее пояснительное слово
 * ТОГО ЖЕ упоминания («скважина №», «уч.», «лиц.», «река») дефектом не считается.
 *
 * Прямой ключ OpenRouter НЕ БРАТЬ: общий кошелёк прода, замер 05.08 его уже обнулял.
 * Идём через AIgate (`AIGATE_API_KEY`, `https://api.aigate.shop`) — свой счёт, `usage.cost_usd`
 * на каждый вызов. `response_format: json_object` шлюз ломает у Gemini (400/502) — формат
 * ответа задаётся только промптом, ответ чистится от ``` перед разбором.
 *
 * ФАЗЫ (--phase), каждая кэшируется на диск и переживает обрыв (resumable jsonl, как annotate.ts):
 *
 *   sample      — прогнать боевой детектор по документам корпуса ЦЕЛИКОМ (--core), собрать
 *                 ПОЛНУЮ популяцию находок по каждому из 4 типов, стратифицированно выбрать
 *                 --per-type (default 200) детерминированным ГПСЧ (--seed, свой LCG, не Math.random)
 *   judge       — прогнать --items через судью --model (резюмируемо: уже осуждённые id::model
 *                 пропускаются); универсальная фаза, ею же гоняются ducks/posbias/agree
 *   gen-ducks   — --ducks (default 20) механических подсадных ложняков: случайное слово из
 *                 текста как WELL, число из середины абзаца как COORD
 *   gen-posbias — --posbias (default 20) находок из выборки, но с выделением СОСЕДНЕГО слова
 *                 той же длины вместо истинного значения — проверка на подсказку в промпте
 *   gen-knownfp — известные классы ложных WELL из живого разбора (глубина/отметка устья
 *                 с якорем «скважина» рядом, без «№») — сканирует корпус на ту же СЕМЬЮ
 *                 ошибок, не только два конкретных случая из `final-КЛИЕНТ-unconfirmed.json`
 *   score       — свести items + verdicts + adjudication-precision.json в отчёт с интервалами
 *                 Уилсона 95 % (по находкам) И бутстрап-интервалом 95 % ПО ДОКУМЕНТАМ (находки
 *                 внутри документа не независимы — одна кривая таблица даёт сотню одинаковых
 *                 ложняков, наивный Уилсон это занижает); по каждому типу отдельно, среднее
 *                 НЕ считается; плюс rejects-дамп и разбор кластеризации по документам
 *   pilot       — sample (если нет items) + judge на --pilot-n (default 10) находках, чтобы
 *                 посчитать цену за находку ДО того, как гнать сотни вызовов
 *   ducks / posbias / knownfp / agree — сгенерировать (если нет) и осудить соответствующий
 *                 срез; agree — те же --agree-n (default 60) находок выборки, но моделью
 *                 --second-model
 *   all         — sample → judge (вся выборка) → score: то, что нужно для боевого прогона
 *
 *   AIGATE_API_KEY=… bun scripts/geo-gold/precision.ts --core /путь/к/worktree --phase all
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const PHASE = arg("phase", "all")!;
const CORE = arg("core", "/Users/evgeniy/projects/proboi-core-geo-measure")!;
const CHUNKS = arg("chunks", ".work/geo-gold/chunks-client.jsonl")!;
const PER_TYPE = Number(arg("per-type", "200"));
const SEED = Number(arg("seed", "20260806"));
const ITEMS = arg("items", ".work/geo-gold/precision-items.jsonl")!;
const DUCKS_ITEMS = arg("ducks-items", ".work/geo-gold/precision-items-ducks.jsonl")!;
const POSBIAS_ITEMS = arg("posbias-items", ".work/geo-gold/precision-items-posbias.jsonl")!;
const KNOWNFP_ITEMS = arg("knownfp-items", ".work/geo-gold/precision-items-knownfp.jsonl")!;
const DUCKS_N = Number(arg("ducks", "20"));
const POSBIAS_N = Number(arg("posbias", "20"));
const KNOWNFP_N = Number(arg("knownfp", "20"));
const VERDICTS = arg("verdicts", ".work/geo-gold/precision-verdicts.jsonl")!;
const OUT = arg("out", ".work/geo-gold/precision.json")!;
const REJECTS = arg("rejects", ".work/geo-gold/precision-rejects.json")!;
const ADJ = arg("adj", "scripts/geo-gold/adjudication-precision.json")!;
const MODEL = arg("model", "google/gemini-3.1-pro-preview")!;
// deepseek/deepseek-v3.2 отклоняет запросы этим ключом AIgate 403 «verify your Telegram
// account» (проверено 06.08 — не rate-limit, воспроизводится и при concurrency=1, и после
// минуты остывания); anthropic/claude-haiku-4.5 работает и остаётся другим семейством,
// чем судья-Gemini — это и нужно для проверки согласия.
const SECOND_MODEL = arg("second-model", "anthropic/claude-haiku-4.5")!;
const AGREE_N = Number(arg("agree-n", "60"));
const PILOT_N = Number(arg("pilot-n", "10"));
const LIMIT = Number(arg("limit", "0"));
const CONC = Number(arg("conc", "10"));
const BASE = arg("base", process.env.AIGATE_BASE_URL ?? "https://api.aigate.shop")!;
const KEY = process.env.AIGATE_API_KEY;

// ── детерминированный ГПСЧ (Math.random запрещён — прогон обязан воспроизводиться)
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function shuffle<T>(a: T[], rnd: () => number): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ── доверительный интервал Уилсона 95 %
function wilson(x: number, n: number, z = 1.959963985): { p: number; lo: number; hi: number } {
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfw = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - halfw), hi: Math.min(1, center + halfw) };
}
/**
 * Поправка на конечную совокупность (FPC). Уилсон выше выведен из биномиальной модели —
 * выборка бесконечно малой доли БЕСКОНЕЧНОЙ популяции. Когда выборка — заметная доля КОНЕЧНОЙ
 * популяции (у нас LICENSE_SUBSOIL 71 из 71 и COORD 110 из 110 — это НЕ выборка, а перепись:
 * судья осудил КАЖДУЮ находку детектора этого типа в корпусе), наивный интервал завышает
 * неопределённость — он моделирует риск «не той выборке не повезло», а такого риска нет,
 * когда выборка совпадает с популяцией целиком. Множитель — стандартный FPC = sqrt((N−n)/(N−1));
 * при n=N он равен 0, и интервал схлопывается в точку — это ПРАВИЛЬНО: сомнений «что покажет
 * другая выборка» больше нет, потому что другой выборки не существовало. Единственная
 * оставшаяся неопределённость в этом случае — шум самого судьи, а его эта статистика не ловит
 * (для этого и нужна отдельная проверка «согласие судей»).
 */
function wilsonFPC(x: number, n: number, N: number | null, z = 1.959963985): { p: number; lo: number; hi: number; fpc: number; census: boolean } {
  const base = wilson(x, n, z);
  if (N == null || N <= n) return { p: base.p, lo: base.p, hi: base.p, fpc: 0, census: true };
  const fpc = N > 1 ? Math.sqrt((N - n) / (N - 1)) : 0;
  const lo = Math.max(0, base.p - (base.p - base.lo) * fpc);
  const hi = Math.min(1, base.p + (base.hi - base.p) * fpc);
  return { p: base.p, lo, hi, fpc, census: false };
}
const pct1 = (x: number) => Math.round(x * 1000) / 10;

// ── 4 типа, которые мерим. Описания — ЧЕЛОВЕЧЕСКИМИ СЛОВАМИ, дословно из annotate.ts обоих
// харнессов полноты (geo-gold и geo-coord): иначе точность и полнота меряли бы разные
// определения сущности, и цифры перестали бы быть сравнимы.
type Measured = "WELL" | "GEO_NAME" | "LICENSE_SUBSOIL" | "COORD";
const MEASURED: readonly Measured[] = ["WELL", "GEO_NAME", "LICENSE_SUBSOIL", "COORD"];

const TYPE_DESCRIPTIONS: Record<Measured, string> = {
  WELL: "обозначение КОНКРЕТНОЙ скважины: её номер или шифр. Примеры того, что это: «4-Р», «№ 12», «С-5», «Х-3132», «33/2», «1-бис». Считается любое упоминание, включая строки таблицы, где слово «скважина» стоит только в шапке столбца или вовсе в заголовке таблицы. НЕ считается: количество скважин («пробурено 7 скважин»), глубина, отметка устья, диаметр, дебит, любые метры, проценты и денежные суммы.",
  GEO_NAME: "собственное имя объекта, по которому можно показать на карте МЕСТО РАБОТ с точностью до участка: имя месторождения, рудопроявления, участка недр, площади, залежи, рудного поля, лицензионного участка, а также название реки, ручья, озера, урочища, горы, хребта. НЕ считается: административные единицы (область, край, район, городской округ, город, посёлок, село, улица), страны, названия организаций и их филиалов, фамилии людей, названия геологических свит/горизонтов/комплексов/пород, названия документов, программ и приборов. НЕ считается и крупная региональная структура — «Сибирская платформа», «Балтийский щит», «Западно-Сибирская плита», синеклизы, антеклизы, прогибы, нефтегазоносные провинции и бассейны: это масштаб региона, а не место работ.",
  LICENSE_SUBSOIL: "номер лицензии на пользование недрами. Обычная запись: три буквы, пять-шесть цифр, две буквы — «ЯКУ 12345 НР», «БЛГ № 01234 ТЭ», «ИРК 02345 БР».",
  COORD: "число, которое говорит, ГДЕ НА ЗЕМЛЕ находится точка, — то есть по которому можно поставить точку на карте: широта и долгота (угловая привязка к земному шару, хоть в градусах с минутами и секундами, хоть числом с дробной частью) ИЛИ прямоугольные (проекционные) координаты в метрах — так задают положение точки в маркшейдерских и буровых журналах, в каталогах угловых точек участка, на планах и разрезах. НЕ считается: азимуты, дирекционные углы, углы наклона, падения, простирания (это направление, а не место); абсолютные отметки высот, глубины, мощности, интервалы, расстояния, пикеты, диаметры; номенклатура листов карты («Р-55-69», «М-53-XIII») и масштаб («1:50 000»); температуры, содержания, объёмы, проценты, площади, денежные суммы; номера скважин, лицензий, документов, даты, телефоны.",
};

function buildPrompt(ctx400: string): string {
  return `Ты — геолог-редактор. Ниже фрагмент российского документа: геологический отчёт, буровой журнал, проект геологоразведочных работ, конкурсная документация или извещение о торгах на участок недр. Текст может быть выходом распознавания скана — с опечатками, разорванными таблицами, лишними пробелами. Внутри фрагмента один кусок выделен знаками ⟦ и ⟧.

Определи, к какому из следующих видов сведений относится ВЫДЕЛЕННЫЙ фрагмент. Выбери РОВНО ОДИН вариант.

1. WELL — ${TYPE_DESCRIPTIONS.WELL}
2. GEO_NAME — ${TYPE_DESCRIPTIONS.GEO_NAME}
3. LICENSE_SUBSOIL — ${TYPE_DESCRIPTIONS.LICENSE_SUBSOIL}
4. COORD — ${TYPE_DESCRIPTIONS.COORD}
5. NONE — выделенный фрагмент не относится ни к одному из перечисленных четырёх видов сведений.

Если выбрал 1–4, дополнительно оцени границы выделения ⟦…⟧:
- "exact" — границы верны. Это ВКЛЮЧАЕТ случай, когда рядом со значением внутри выделения стоит
  непосредственно относящееся к НЕМУ ЖЕ поясняющее слово того же упоминания — «скважина №» перед
  номером скважины, «уч.»/«участок»/«месторождение» перед именем в кавычках, «река»/«ручей» перед
  названием. Такое пояснение — часть одного и того же упоминания, а не лишний текст, и too_wide
  тут ставить НЕ НАДО;
- "too_wide" — выделение продолжается в текст ДРУГОЙ, самостоятельной сущности (например,
  залезает в номер СОСЕДНЕЙ скважины, в другое число, в другое имя) либо прихватывает текст,
  вообще не связанный со значением (случайное слово или пунктуация из другого места фразы);
- "too_narrow" — сущность обрезана, часть значения осталась за пределами выделения.
Если выбрал NONE — верни "границы": null.

Решай по смыслу выделенного фрагмента и окружающего текста. Ничего не додумывай сверх написанного и не пытайся угадать, зачем этот фрагмент выделили.

Ответ — ТОЛЬКО JSON, без пояснений:
{"тип":"WELL|GEO_NAME|LICENSE_SUBSOIL|COORD|NONE","границы":"exact|too_wide|too_narrow"|null,"комментарий":"кратко, одна фраза"}

ФРАГМЕНТ ДОКУМЕНТА:
${ctx400}`;
}

// ── типы данных
type Item = {
  id: string;
  kind: "real" | "duck" | "posbias" | "knownfp";
  type: Measured;
  corpus: string;
  doc_id: string;
  value: string;
  start: number;
  end: number;
  ctx400: string;
  ctx200: string;
  orig_id?: string;
  orig_value?: string;
};
type VerdictRow = {
  id: string;
  kind: string;
  declared_type: Measured;
  model: string;
  тип: string;
  границы: string | null;
  комментарий?: string;
  usage?: unknown;
};

// ── загрузка корпуса (тот же реестр файлов, что в score.ts)
const CORPUS_FILES: Record<string, string> = {
  "eis-geo": ".corpus/texts.jsonl",
  scans: ".corpus/scans.jsonl",
  rosnedra: ".corpus/rosnedra.jsonl",
  "client-scans": ".corpus/client-scans.jsonl",
};
type DocRec = { corpus: string; doc_id: string; text: string };
const docKey = (corpus: string, doc_id: string) => `${corpus} ${doc_id}`;

function loadDocScope(chunksFile: string): { corpus: string; doc_id: string }[] {
  const seen = new Set<string>();
  const out: { corpus: string; doc_id: string }[] = [];
  for (const l of readFileSync(chunksFile, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const c = JSON.parse(l) as { corpus: string; doc_id: string };
    const k = docKey(c.corpus, c.doc_id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ corpus: c.corpus, doc_id: c.doc_id });
  }
  return out;
}
function loadDocTexts(scope: { corpus: string; doc_id: string }[]): Map<string, DocRec> {
  const wanted = new Set(scope.map((s) => docKey(s.corpus, s.doc_id)));
  const corpora = new Set(scope.map((s) => s.corpus));
  const out = new Map<string, DocRec>();
  for (const corpus of corpora) {
    // Новый корпус не требует правки CORPUS_FILES: имя корпуса = имя файла в .corpus/
    // (тот же фолбэк, что завели в score.ts). Явная карта — для исторических имён, которые
    // файлу не соответствуют.
    const file = CORPUS_FILES[corpus] ?? (existsSync(`.corpus/${corpus}.jsonl`) ? `.corpus/${corpus}.jsonl` : undefined);
    if (!file) throw new Error(`неизвестный корпус: ${corpus}`);
    for (const l of readFileSync(file, "utf8").split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as { doc_id: string; text: string };
      const k = docKey(corpus, r.doc_id);
      if (wanted.has(k)) out.set(k, { corpus, doc_id: r.doc_id, text: r.text });
    }
  }
  return out;
}

/** ±radius знаков вокруг [start,end), сама сущность отмечена ⟦…⟧ — так же, как в build_*_markup.py. */
function ctxAround(text: string, start: number, end: number, radius: number): string {
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, end + radius);
  return (text.slice(a, start) + "⟦" + text.slice(start, end) + "⟧" + text.slice(end, b))
    .replace(/\s+/g, " ")
    .trim();
}

// ── шаг 1: популяция + выборка
type PopEntry = { type: Measured; corpus: string; doc_id: string; start: number; end: number; value: string };

async function collectPopulation(core: string, docTexts: Map<string, DocRec>): Promise<Record<Measured, PopEntry[]>> {
  const { detectEntities, resolveOverlaps } = await import(`${core}/core/src/privacy/deid/detect.ts`);
  const { spreadGeoNames } = await import(`${core}/core/src/privacy/deid/geo-spread.ts`);
  const { spreadSurfaces } = await import(`${core}/core/src/privacy/deid/spread.ts`);
  const { entitiesForVertical } = await import(`${core}/core/src/privacy/deid/entities.ts`);
  const TYPES = entitiesForVertical("geo") as string[];
  type Ent = { type: string; raw: string; index: number };
  function detect(text: string): Ent[] {
    let ents = detectEntities(text, TYPES) as Ent[];
    if (TYPES.includes("GEO_NAME")) ents = resolveOverlaps([...ents, ...spreadGeoNames(text, ents)]);
    ents = resolveOverlaps([...ents, ...spreadSurfaces(text, ents)]);
    return ents;
  }
  const population: Record<Measured, PopEntry[]> = { WELL: [], GEO_NAME: [], LICENSE_SUBSOIL: [], COORD: [] };
  for (const rec of docTexts.values()) {
    const ents = detect(rec.text);
    for (const e of ents) {
      if (!(MEASURED as readonly string[]).includes(e.type)) continue;
      const start = e.index, end = e.index + e.raw.length;
      population[e.type as Measured].push({ type: e.type as Measured, corpus: rec.corpus, doc_id: rec.doc_id, start, end, value: e.raw });
    }
  }
  return population;
}

async function phaseSample() {
  const scope = loadDocScope(CHUNKS);
  const docTexts = loadDocTexts(scope);
  console.log(`документов в скоупе: ${docTexts.size} (${CHUNKS})`);
  const population = await collectPopulation(CORE, docTexts);
  const rnd = rng(SEED);
  const perType: Record<Measured, Item[]> = { WELL: [], GEO_NAME: [], LICENSE_SUBSOIL: [], COORD: [] };
  const popSummary: Record<string, { population: number; sample: number; populationLessThanSample: boolean }> = {};

  for (const type of MEASURED) {
    const pool = population[type];
    // НЕ дедуплицируем по значению: одно и то же значение, встреченное 50 раз, вносит в
    // заявляемую цифру 50 находок — иначе оценка смещена.
    const picked = shuffle(pool, rnd).slice(0, Math.min(PER_TYPE, pool.length));
    popSummary[type] = { population: pool.length, sample: picked.length, populationLessThanSample: pool.length < PER_TYPE };
    for (const p of picked) {
      const rec = docTexts.get(docKey(p.corpus, p.doc_id))!;
      perType[type].push({
        id: `real:${p.type}:${p.corpus}:${p.doc_id}:${p.start}:${p.end}`,
        kind: "real",
        type: p.type,
        corpus: p.corpus,
        doc_id: p.doc_id,
        value: p.value,
        start: p.start,
        end: p.end,
        ctx400: ctxAround(rec.text, p.start, p.end, 400),
        ctx200: ctxAround(rec.text, p.start, p.end, 200),
      });
    }
  }

  // Круговой интерлив по типам: любой ПРЕФИКС файла (важно для --limit в пилоте и --agree-n)
  // остаётся представительной смесью всех 4 типов, а не «первые 200 — сплошь WELL».
  const items: Item[] = [];
  const maxLen = Math.max(...MEASURED.map((t) => perType[t].length));
  for (let i = 0; i < maxLen; i++) for (const t of MEASURED) if (perType[t][i]) items.push(perType[t][i]!);

  mkdirSync(dirname(ITEMS), { recursive: true });
  writeFileSync(ITEMS, items.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  writeFileSync(ITEMS.replace(/\.jsonl$/, "-population.json"), JSON.stringify(popSummary, null, 2), "utf8");
  console.log("популяция/выборка по типам:", popSummary);
  console.log(`items (${items.length}) → ${ITEMS}`);
}

// ── шаг 2а: подсадные утки (механически, БЕЗ детектора)
function pickWordToken(text: string, rnd: () => number): { value: string; start: number; end: number } | null {
  const re = /[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\-/]{1,14}/gu;
  const m = [...text.matchAll(re)];
  if (!m.length) return null;
  const pick = m[Math.floor(rnd() * m.length)]!;
  return { value: pick[0], start: pick.index!, end: pick.index! + pick[0].length };
}
/** «Число из середины абзаца»: далеко и от начала, и от конца своей строки, строка длинная (проза, не строка таблицы). */
function pickMidParagraphNumber(text: string, rnd: () => number): { value: string; start: number; end: number } | null {
  const re = /\d{1,4}(?:[.,]\d+)?/g;
  const cands: { value: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index, end = start + m[0].length;
    const nlBefore = text.lastIndexOf("\n", start);
    const nlAfter = text.indexOf("\n", end);
    const lineStart = nlBefore < 0 ? 0 : nlBefore + 1;
    const lineEnd = nlAfter < 0 ? text.length : nlAfter;
    if (lineEnd - lineStart > 200 && start - lineStart > 60 && lineEnd - end > 60) {
      cands.push({ value: m[0], start, end });
    }
  }
  if (!cands.length) return null;
  return cands[Math.floor(rnd() * cands.length)]!;
}

async function phaseGenDucks() {
  const scope = loadDocScope(CHUNKS);
  const docTexts = [...loadDocTexts(scope).values()];
  const rnd = rng(SEED + 777);
  const halfWell = Math.ceil(DUCKS_N / 2);
  const halfCoord = DUCKS_N - halfWell;
  const items: Item[] = [];
  let tries = 0;
  while (items.filter((i) => i.type === "WELL").length < halfWell && tries < 20000) {
    tries++;
    const d = docTexts[Math.floor(rnd() * docTexts.length)]!;
    const tok = pickWordToken(d.text, rnd);
    if (!tok) continue;
    items.push({
      id: `duck:WELL:${items.length}`, kind: "duck", type: "WELL", corpus: d.corpus, doc_id: d.doc_id,
      value: tok.value, start: tok.start, end: tok.end,
      ctx400: ctxAround(d.text, tok.start, tok.end, 400), ctx200: ctxAround(d.text, tok.start, tok.end, 200),
    });
  }
  tries = 0;
  while (items.filter((i) => i.type === "COORD").length < halfCoord && tries < 20000) {
    tries++;
    const d = docTexts[Math.floor(rnd() * docTexts.length)]!;
    const num = pickMidParagraphNumber(d.text, rnd);
    if (!num) continue;
    items.push({
      id: `duck:COORD:${items.length}`, kind: "duck", type: "COORD", corpus: d.corpus, doc_id: d.doc_id,
      value: num.value, start: num.start, end: num.end,
      ctx400: ctxAround(d.text, num.start, num.end, 400), ctx200: ctxAround(d.text, num.start, num.end, 200),
    });
  }
  mkdirSync(dirname(DUCKS_ITEMS), { recursive: true });
  writeFileSync(DUCKS_ITEMS, items.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  console.log(`подсадных уток: ${items.length} (WELL ${halfWell}, COORD ${halfCoord}) → ${DUCKS_ITEMS}`);
}

// ── шаг 2б: смещение выделения на соседнее слово той же длины (проверка на подсказку в промпте)
function findNeighborToken(text: string, start: number, end: number, targetLen: number, rnd: () => number) {
  const excl = 15; // зона вокруг самой сущности и её ключа — не берём соседей отсюда
  const re = /[^\s]+/gu;
  const cands: { value: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m.index, e = s + m[0].length;
    if (e > start - excl && s < end + excl) continue;
    if (Math.abs(m[0].length - targetLen) <= 1) cands.push({ value: m[0], start: s, end: e });
  }
  if (!cands.length) return null;
  return cands[Math.floor(rnd() * cands.length)]!;
}

async function phaseGenPosbias() {
  if (!existsSync(ITEMS)) throw new Error(`нет ${ITEMS} — сначала --phase sample`);
  const real: Item[] = readFileSync(ITEMS, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const scope = loadDocScope(CHUNKS);
  const docTexts = loadDocTexts(scope);
  const rnd = rng(SEED + 999);
  const picked = shuffle(real, rnd);
  const items: Item[] = [];
  for (const r of picked) {
    if (items.length >= POSBIAS_N) break;
    const rec = docTexts.get(docKey(r.corpus, r.doc_id));
    if (!rec) continue;
    const nb = findNeighborToken(rec.text, r.start, r.end, r.end - r.start, rnd);
    if (!nb) continue;
    items.push({
      id: `posbias:${r.id}`, kind: "posbias", type: r.type, corpus: r.corpus, doc_id: r.doc_id,
      value: nb.value, start: nb.start, end: nb.end, orig_id: r.id, orig_value: r.value,
      ctx400: ctxAround(rec.text, nb.start, nb.end, 400), ctx200: ctxAround(rec.text, nb.start, nb.end, 200),
    });
  }
  mkdirSync(dirname(POSBIAS_ITEMS), { recursive: true });
  writeFileSync(POSBIAS_ITEMS, items.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  console.log(`смещённых выделений: ${items.length} → ${POSBIAS_ITEMS}`);
}

// ── шаг 2в: известные классы ложных WELL — НЕ гипотетические, найдены живым разбором
// `.work/geo-gold/final-КЛИЕНТ-unconfirmed.json`: «скважины 4» из «Общая глубина скважины
// 4,0 м», «скважины 10210» из «Отметка устья скважины 10210 м». Оба — правило WELL сработало
// на бытовое соседство слова «скважина» с числом (глубина/отметка устья), а не на настоящий
// номер скважины (номер почти всегда идёт через «№», а тут его нет). Сканируем корпус на всю
// СЕМЬЮ такой ошибки регуляркой, а не только эти два конкретных случая — переживает смену
// корпуса. Судья ОБЯЗАН отвергать (тип ≠ WELL, скорее NONE): если подтверждает — промпт
// поддакивает на форме «слово скважина + число рядом», и строгую точность WELL верить нельзя.
const KNOWNFP_CLASSES: { label: string; contextRe: RegExp }[] = [
  { label: "depth-as-well", contextRe: /глубин[а-яё]*/iu },
  { label: "elevation-as-well", contextRe: /отметк[а-яё]*\s+устья/iu },
];

async function phaseGenKnownFP() {
  const scope = loadDocScope(CHUNKS);
  const docTexts = [...loadDocTexts(scope).values()];
  const re = /скважин[а-яё]*\s+\d+(?:[.,]\d+)?/giu;
  const found: { cls: string; d: DocRec; start: number; end: number; value: string }[] = [];
  for (const d of docTexts) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(d.text))) {
      const value = m[0];
      if (/№/u.test(value)) continue; // с «№» — как правило, настоящий номер, не эта ошибка
      const start = m.index, end = start + value.length;
      const before = d.text.slice(Math.max(0, start - 60), start);
      const cls = KNOWNFP_CLASSES.find((c) => c.contextRe.test(before));
      if (cls) found.push({ cls: cls.label, d, start, end, value });
    }
  }
  const rnd = rng(SEED + 4242);
  const items: Item[] = [];
  const perClass = Math.ceil(KNOWNFP_N / KNOWNFP_CLASSES.length);
  for (const cls of KNOWNFP_CLASSES) {
    const pool = shuffle(found.filter((f) => f.cls === cls.label), rnd);
    for (const f of pool.slice(0, perClass)) {
      items.push({
        id: `knownfp:${cls.label}:${items.length}`, kind: "knownfp", type: "WELL",
        corpus: f.d.corpus, doc_id: f.d.doc_id, value: f.value, start: f.start, end: f.end,
        ctx400: ctxAround(f.d.text, f.start, f.end, 400), ctx200: ctxAround(f.d.text, f.start, f.end, 200),
      });
    }
  }
  mkdirSync(dirname(KNOWNFP_ITEMS), { recursive: true });
  writeFileSync(KNOWNFP_ITEMS, items.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  console.log(`известных ложняков WELL: ${items.length} из ${found.length} найденных в корпусе → ${KNOWNFP_ITEMS}`);
  if (!items.length) console.log("  ВНИМАНИЕ: ни одного известного ложняка не найдено в текущем скоупе — проверка пуста.");
}

// ── шаг 3: судья
async function askJudge(model: string, ctx400: string): Promise<{ raw: string; usage: unknown }> {
  if (!KEY) throw new Error("нет AIGATE_API_KEY");
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: buildPrompt(ctx400) }],
      max_tokens: 2000,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as any;
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error(`пустой ответ: ${JSON.stringify(j).slice(0, 200)}`);
  return { raw: content, usage: j.usage };
}

async function runJudge(itemsFile: string, model: string, limit: number, conc: number, verdictsFile: string) {
  const items: Item[] = readFileSync(itemsFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const done = new Set<string>();
  if (existsSync(verdictsFile)) {
    for (const l of readFileSync(verdictsFile, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { const v = JSON.parse(l) as VerdictRow; done.add(`${v.id}::${v.model}`); } catch { /* битая строка */ }
    }
  }
  const pending = items.filter((it) => !done.has(`${it.id}::${model}`));
  const todo = pending.slice(0, limit || undefined);
  console.log(`к оценке: ${todo.length} (уже оценено ${items.length - pending.length} из ${items.length}), модель ${model}, из ${itemsFile}`);
  mkdirSync(dirname(verdictsFile), { recursive: true });

  let idx = 0, ok = 0, fail = 0, cost = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= todo.length) return;
      const it = todo[i]!;
      let lastErr = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { raw, usage } = await askJudge(model, it.ctx400);
          const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
          const тип = String(parsed?.тип ?? "").trim().toUpperCase();
          const границы = parsed?.границы === "exact" || parsed?.границы === "too_wide" || parsed?.границы === "too_narrow" ? parsed.границы : null;
          const row: VerdictRow = {
            id: it.id, kind: it.kind, declared_type: it.type, model,
            тип, границы, комментарий: String(parsed?.комментарий ?? "").slice(0, 300), usage,
          };
          appendFileSync(verdictsFile, JSON.stringify(row) + "\n");
          ok++; lastErr = "";
          cost += Number((usage as { cost_usd?: number } | undefined)?.cost_usd ?? 0);
          if (ok % 20 === 0 || limit) console.log(`  ${ok}/${todo.length} готово, потрачено $${cost.toFixed(4)}`);
          break;
        } catch (e: any) {
          lastErr = String(e?.message ?? e).slice(0, 140);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
        }
      }
      if (lastErr) { fail++; console.log(`  ПРОВАЛ ${it.id}: ${lastErr}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, conc) }, () => worker()));
  console.log(`оценено ${ok}, провалов ${fail}, потрачено $${cost.toFixed(4)} → ${verdictsFile}`);
  if (limit && ok > 0) console.log(`ПИЛОТ: цена за находку ≈ $${(cost / ok).toFixed(4)}`);
}

// ── шаг 4: счёт
/**
 * Бутстрап 95 % ПО ДОКУМЕНТАМ. Находки внутри документа не независимы: одна кривая таблица
 * рождает сотню одинаковых ложняков, и наивный Уилсон (который считает находки независимыми
 * бросками монеты) в этом случае занижает неопределённость. Ресемплируем ДОКУМЕНТЫ с
 * возвращением; внутри выбранного документа берём ВСЕ его находки из выборки целиком (не
 * ресемплируем находки внутри документа второй раз — кластер должен остаться кластером).
 * 1000 итераций, перцентили 2,5 и 97,5. Свой ГПСЧ — тот же LCG, не Math.random.
 */
function bootstrapDocCI(rows: { doc_id: string; correct: boolean }[], rnd: () => number, iters = 1000): { lo: number; hi: number } | null {
  const byDoc = new Map<string, boolean[]>();
  for (const r of rows) {
    const arr = byDoc.get(r.doc_id) ?? [];
    arr.push(r.correct);
    byDoc.set(r.doc_id, arr);
  }
  const docs = [...byDoc.keys()];
  if (!docs.length) return null;
  const props: number[] = [];
  for (let it = 0; it < iters; it++) {
    let total = 0, correct = 0;
    for (let i = 0; i < docs.length; i++) {
      const arr = byDoc.get(docs[Math.floor(rnd() * docs.length)]!)!;
      total += arr.length;
      correct += arr.reduce((s, v) => s + (v ? 1 : 0), 0);
    }
    props.push(total ? correct / total : 0);
  }
  props.sort((a, b) => a - b);
  const lo = props[Math.max(0, Math.floor(0.025 * iters) - 1)]!;
  const hi = props[Math.min(iters - 1, Math.floor(0.975 * iters))]!;
  return { lo, hi };
}

function loadItems(file: string): Item[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function loadVerdicts(file: string): VerdictRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function phaseScore() {
  const real = loadItems(ITEMS);
  const ducks = loadItems(DUCKS_ITEMS);
  const posbias = loadItems(POSBIAS_ITEMS);
  const knownfp = loadItems(KNOWNFP_ITEMS);
  const verdicts = loadVerdicts(VERDICTS);
  const popFile = ITEMS.replace(/\.jsonl$/, "-population.json");
  const pop: Record<string, { population: number; sample: number; populationLessThanSample: boolean }> =
    existsSync(popFile) ? JSON.parse(readFileSync(popFile, "utf8")) : {};

  // Разбор глазами отвергнутых находок — см. шапку файла: правилам детектора его крутить нельзя.
  const adj: Record<string, Record<string, string>> = existsSync(ADJ) ? JSON.parse(readFileSync(ADJ, "utf8")) : {};
  const overrideOf = (type: string, value: string) => adj[type]?.[value]; // "correct" | "incorrect" | "exclude" | undefined

  const vBy = new Map<string, VerdictRow>();
  for (const v of verdicts) vBy.set(`${v.id}::${v.model}`, v);

  const rejects: { id: string; type: string; corpus: string; doc_id: string; value: string; ctx: string; судья_тип: string; судья_границы: string | null; комментарий?: string }[] = [];
  const perType: Record<string, unknown> = {};
  const bootstrapRnd = rng(SEED + 8080); // отдельный поток ГПСЧ под бутстрап, детерминированный
  for (const type of MEASURED) {
    const items = real.filter((it) => it.type === type);
    let soft = 0, strict = 0, judged = 0, excluded = 0;
    const softRows: { doc_id: string; correct: boolean }[] = [];
    const strictRows: { doc_id: string; correct: boolean }[] = [];
    for (const it of items) {
      const v = vBy.get(`${it.id}::${MODEL}`);
      if (!v) continue; // ещё не оценено судьёй
      const ov = overrideOf(it.type, it.value);
      if (ov === "exclude") { excluded++; continue; } // человек решил: шум, вон из знаменателя
      judged++;
      const typeMatch = ov === "correct" ? true : ov === "incorrect" ? false : v.тип === it.type;
      const boundExact = v.границы === "exact";
      softRows.push({ doc_id: it.doc_id, correct: typeMatch });
      strictRows.push({ doc_id: it.doc_id, correct: typeMatch && boundExact });
      if (typeMatch) { soft++; if (boundExact) strict++; }
      else {
        rejects.push({
          id: it.id, type: it.type, corpus: it.corpus, doc_id: it.doc_id, value: it.value,
          ctx: it.ctx200, судья_тип: v.тип, судья_границы: v.границы, комментарий: v.комментарий,
        });
      }
    }
    // N — размер ПОЛНОЙ популяции этого типа в корпусе (из sample-фазы). Если известна и
    // judged её покрывает — это перепись, не выборка (LICENSE_SUBSOIL, COORD на клиентском
    // корпусе: 71 из 71 и 110 из 110), и FPC-поправка в wilsonFPC схлопнет интервал в точку.
    const N = pop[type]?.population ?? null;
    const wSoft = judged ? wilsonFPC(soft, judged, N) : null;
    const wStrict = judged ? wilsonFPC(strict, judged, N) : null;
    const bSoft = judged ? bootstrapDocCI(softRows, bootstrapRnd) : null;
    const bStrict = judged ? bootstrapDocCI(strictRows, bootstrapRnd) : null;
    // Сколько РАЗНЫХ документов вообще дало находки этого типа в выборке — тот самый
    // «эффективный n» бутстрапа. Мало документов (замер полноты 06.08: 40 документов дали
    // WELL[63,8–69,4] Уилсоном, но [52,0–80,2] бутстрапом — разница ВТРОЕ, потому что
    // документов мало и результат по ним гуляет 0→100%) — надо называть цифру, а не прятать.
    const docsWithFindings = new Set(softRows.map((r) => r.doc_id)).size;

    // Кластеризация ложняков по документам: сколько документов вообще дали ошибку, и какая
    // доля ВСЕХ ложняков этого типа пришла из одного, самого «грязного» документа. Если это
    // ¾ — цифра точности держится на одном кривом файле, а не на общем качестве правила.
    const typeRejects = rejects.filter((r) => r.type === type);
    const rejectsByDoc = new Map<string, number>();
    for (const r of typeRejects) rejectsByDoc.set(r.doc_id, (rejectsByDoc.get(r.doc_id) ?? 0) + 1);
    const maxDocRejects = rejectsByDoc.size ? Math.max(...rejectsByDoc.values()) : 0;

    perType[type] = {
      популяция: N,
      выборка: items.length,
      оценено: judged,
      документовДалиНаходки: docsWithFindings,
      исключеноРазбором: excluded || undefined,
      // true ⇒ судья видел КАЖДУЮ находку этого типа в корпусе (перепись), не подвыборку.
      перепись: wSoft?.census ?? null,
      // ПОРЯДОК НАМЕРЕННЫЙ (правка 06.08 по находке на полноте — та же ловушка бьёт и
      // точность): 1) точка; 2) бутстрап по документам — ОСНОВНОЙ интервал, потому что
      // находки внутри документа коррелированы; 3) Уилсон по находкам — ПОСЛЕДНИМ и с
      // прямой пометкой, что он не годится сам по себе (см. заметка ниже).
      точностьМягкая: judged ? pct1(soft / judged) : null,
      точностьСтрогая: judged ? pct1(strict / judged) : null,
      bootstrap95_поДокументам: bSoft && bStrict
        ? {
            мягкая: [pct1(bSoft.lo), pct1(bSoft.hi)], строгая: [pct1(bStrict.lo), pct1(bStrict.hi)],
            документовВБутстрапе: docsWithFindings,
            заметка: wSoft?.census
              ? "перепись: этот интервал НЕ про выборочную ошибку (её нет, осуждена вся " +
                "популяция) — он про то, насколько результат чувствителен к составу ИМЕННО " +
                "ЭТИХ документов корпуса (устойчивость к кластеризации, не сэмплингу)"
              : `основной интервал (не Уилсон ниже) — находки внутри документа коррелированы; ` +
                `при ${docsWithFindings} документах интервал по построению шире, чем кажется по ` +
                `размеру выборки находок, и это честно`,
          }
        : null,
      wilson95_поНаходкам_НАИВНЫЙ: wSoft && wStrict
        ? {
            мягкая: [pct1(wSoft.lo), pct1(wSoft.hi)], строгая: [pct1(wStrict.lo), pct1(wStrict.hi)],
            поправкаНаКонечнуюПопуляцию: !wSoft.census,
            предупреждение: "считает находки независимыми бросками монеты, чем они не являются " +
              "(находки внутри документа коррелированы) — смотреть bootstrap95_поДокументам выше, " +
              "этот интервал приведён для сравнения, не как основной",
          }
        : null,
      кластеризацияЛожняков: typeRejects.length
        ? {
            документовСОшибками: rejectsByDoc.size,
            ложняковВсего: typeRejects.length,
            максДоляОдногоДокумента: pct1(maxDocRejects / typeRejects.length),
          }
        : null,
    };
  }

  // подсадные утки: судья ОБЯЗАН отвергать (тип не должен совпасть с фальшивым ярлыком)
  const duckRows = ducks.map((it) => ({ it, v: vBy.get(`${it.id}::${MODEL}`) })).filter((x) => x.v);
  const duckConfirmed = duckRows.filter((x) => x.v!.тип === x.it.type);

  // смещение позиции: судья ОБЯЗАН отвергать (соседнее слово — не та сущность)
  const posRows = posbias.map((it) => ({ it, v: vBy.get(`${it.id}::${MODEL}`) })).filter((x) => x.v);
  const posConfirmed = posRows.filter((x) => x.v!.тип === x.it.type);

  // известные ложняки WELL (глубина/отметка устья): судья ОБЯЗАН отвергать
  const knownfpRows = knownfp.map((it) => ({ it, v: vBy.get(`${it.id}::${MODEL}`) })).filter((x) => x.v);
  const knownfpConfirmed = knownfpRows.filter((x) => x.v!.тип === x.it.type);

  // согласие судей: primary vs second model на пересечении id
  const agreeRows = real
    .map((it) => ({ it, a: vBy.get(`${it.id}::${MODEL}`), b: vBy.get(`${it.id}::${SECOND_MODEL}`) }))
    .filter((x) => x.a && x.b);
  const agreeMatch = agreeRows.filter((x) => x.a!.тип === x.b!.тип);

  const totalCost = verdicts.reduce((s, v) => s + Number((v.usage as { cost_usd?: number } | undefined)?.cost_usd ?? 0), 0);

  const report = {
    поТипам: perType,
    проверкаИзмерителя: {
      подсаднаяУтка: {
        N: duckRows.length, судьяПодтвердилЛожняк: duckConfirmed.length,
        доляПодтверждений: duckRows.length ? pct1(duckConfirmed.length / duckRows.length) : null,
        примеры_если_подтвердил: duckConfirmed.slice(0, 5).map((x) => ({ value: x.it.value, type: x.it.type, ctx: x.it.ctx200 })),
      },
      смещениеПозиции: {
        N: posRows.length, судьяПодтвердилСмещённое: posConfirmed.length,
        доляПодтверждений: posRows.length ? pct1(posConfirmed.length / posRows.length) : null,
      },
      известныеЛожнякиWELL: {
        N: knownfpRows.length, судьяПодтвердилЛожняк: knownfpConfirmed.length,
        доляПодтверждений: knownfpRows.length ? pct1(knownfpConfirmed.length / knownfpRows.length) : null,
        примеры_если_подтвердил: knownfpConfirmed.slice(0, 5).map((x) => ({ value: x.it.value, ctx: x.it.ctx200, судья_тип: x.v!.тип })),
      },
      согласиеСудей: {
        N: agreeRows.length, модельА: MODEL, модельБ: SECOND_MODEL,
        совпало: agreeMatch.length, доляСовпадений: agreeRows.length ? pct1(agreeMatch.length / agreeRows.length) : null,
      },
    },
    деньгиAIgateUSD: Math.round(totalCost * 10000) / 10000,
    методика:
      "популяция — все находки боевого детектора по документам корпуса целиком; выборка — случайная " +
      "равномерная (свой ГПСЧ, фиксированный сид), отдельно по типу, без дедупликации по значению; " +
      "судья решает задачу классификации (5 вариантов, включая «ни один»), находка верна, если ярлык " +
      "судьи совпал с ярлыком детектора; строгая точность требует ещё и exact-границ (конвенция " +
      "границ по типам — в шапке файла); среднее по типам не считается — оно прячет слабые типы. " +
      "ПОРЯДОК ЧИСЕЛ НАМЕРЕННЫЙ (правка 06.08 по замеру полноты — точность бьёт та же ловушка): " +
      "сначала точка (точностьМягкая/Строгая), потом bootstrap95_поДокументам — ОСНОВНОЙ интервал " +
      "(ресемплинг документов с возвращением, 1000 итераций; документовДалиНаходки — сколько РАЗНЫХ " +
      "документов вообще стоит за интервалом, при малом числе интервал по построению широк, и это " +
      "видно из самого числа), и только потом wilson95_поНаходкам_НАИВНЫЙ — он считает находки " +
      "независимыми бросками монеты, чем они внутри документа не являются (одна кривая таблица даёт " +
      "сотню одинаковых находок), и приведён для сравнения, не как основной. Для 'перепись'=true " +
      "(LICENSE_SUBSOIL/COORD, когда судья осудил ВСЮ популяцию — это не подвыборка) Уилсон с FPC " +
      "схлопывается в точку — сомнений «что покажет другая выборка» нет, другой выборки не было; но " +
      "документ-бутстрап при этом остаётся содержательным — это уже не выборочная ошибка (её нет), а " +
      "чувствительность к составу документов именно этого корпуса, разные вопросы, путать нельзя",
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(REJECTS, JSON.stringify(rejects, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`отвергнуто (real) ${rejects.length} → ${REJECTS}`);
}

// ── диспетчер фаз
switch (PHASE) {
  case "sample": await phaseSample(); break;
  case "gen-ducks": await phaseGenDucks(); break;
  case "gen-posbias": await phaseGenPosbias(); break;
  case "gen-knownfp": await phaseGenKnownFP(); break;
  case "judge": await runJudge(ITEMS, MODEL, LIMIT, CONC, VERDICTS); break;
  case "ducks":
    if (!existsSync(DUCKS_ITEMS)) await phaseGenDucks();
    await runJudge(DUCKS_ITEMS, MODEL, 0, CONC, VERDICTS);
    break;
  case "posbias":
    if (!existsSync(POSBIAS_ITEMS)) await phaseGenPosbias();
    await runJudge(POSBIAS_ITEMS, MODEL, 0, CONC, VERDICTS);
    break;
  case "knownfp":
    if (!existsSync(KNOWNFP_ITEMS)) await phaseGenKnownFP();
    await runJudge(KNOWNFP_ITEMS, MODEL, 0, CONC, VERDICTS);
    break;
  case "agree": await runJudge(ITEMS, SECOND_MODEL, AGREE_N, CONC, VERDICTS); break;
  case "score": await phaseScore(); break;
  case "pilot":
    if (!existsSync(ITEMS)) await phaseSample();
    await runJudge(ITEMS, MODEL, PILOT_N, CONC, VERDICTS);
    break;
  case "all":
    await phaseSample();
    await runJudge(ITEMS, MODEL, 0, CONC, VERDICTS);
    await phaseScore();
    break;
  default:
    throw new Error(`неизвестная фаза: ${PHASE}`);
}
