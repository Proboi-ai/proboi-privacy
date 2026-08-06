/**
 * Шаг 1 замера ПОЛНОТЫ по WELL / GEO_NAME / LICENSE_SUBSOIL: нарезать выборку кусков текста,
 * которую потом разметит независимый аннотатор (LLM), а не наша же регулярка.
 *
 * Почему не «сеть-подсказка» (validation-geo.ts). Та сеть — тоже регулярка, написанная нами.
 * Она видит только те формы, которые мы УЖЕ придумали, поэтому полнота относительно неё
 * не отвечает на главный вопрос: сколько названий/скважин/лицензий детектор не видит вовсе.
 * Разметка должна приходить из другого источника — отсюда LLM по описанию НА ЧЕЛОВЕЧЕСКОМ
 * языке (что такое скважина/название/лицензия), без единого намёка на наши шаблоны.
 *
 * Корпуса только ПУБЛИЧНЫЕ (ЕИС/Роснедра): их можно отдавать модели наружу, в отличие от
 * архива клиента, ради которого и была придумана сеть-подсказка.
 *
 * Два слоя выборки, и оба нужны:
 *   A «представительный» — куски выбраны случайно. Несмещённая оценка, но гео-сущностей мало.
 *   B «обогащённый» — случайные среди кусков, где есть ХОТЬ КАКОЕ-ТО гео-слово. Даёт объём.
 *     Смещение остаётся (кусок отобран по ключевому слову), но отбор идёт по куску в 3000
 *     знаков, а не по самой находке: внутри такого куска бес-ключевые формы (столбец таблицы
 *     с номерами скважин под шапкой) видны так же, как и ключевые.
 *
 *   bun scripts/geo-gold/sample.ts --out .work/geo-gold/chunks.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const OUT = arg("out", ".work/geo-gold/chunks.jsonl")!;
const CHUNK = Number(arg("chunk", "3000"));
const SEED = Number(arg("seed", "20260806"));

/** Детерминированный ГПСЧ: выборка обязана воспроизводиться (Math.random — нет). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rnd = rng(SEED);
const shuffle = <T>(a: T[]): T[] => {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * Признак «кусок про недра» для слоя B. Слово из одной строки сметы не годится: пилот на трёх
 * кусках корпуса ЕИС дал ноль находок, потому что «скважин» там стояло в расценке
 * («Крепление скважин трубами… ОЗП=1,2»), а «лицензией» — в шаблоне госконтракта. Поэтому
 * требуем ДВА разных геологических слова и отсекаем сметно-договорную обвязку.
 *
 * Отбор остаётся по КУСКУ, а не по находке: внутри такого куска бес-ключевые формы
 * (столбец с номерами скважин под шапкой) видны так же, как ключевые, и попадают в эталон.
 */
const GEO_HINTS = [
  /месторожден/iu,
  /рудопроявлен|проявлени[ея]\s+[«"А-ЯЁ]/u,
  /участк[а-яё]*\s+недр|лиценз[а-яё]*\s+участ/iu,
  /лицензи[а-яё]*\s+на\s+пользование|[А-ЯЁ]{3}\s?\d{5}/u,
  /скважин|скв\.\s*№?\s*\d/iu,
  /координат|широт|долгот/iu,
  /геологоразвед|поисков[а-яё]*\s+работ|разведочн/iu,
  /запас[а-яё]*\s+(?:руд|золот|нефт|газ|угл)|россып|рудн[а-яё]*\s+тел/iu,
];
/** Смета и договорная обвязка: слова те же, геологии нет. */
const NOT_GEO = /ОЗП=|чел\.-ч|ЭМ=1|Форс-мажор|настоящего Контракта|Государственный заказчик/iu;
/**
 * Порог зависит от корпуса. ЕИС — закупки, геология там разбавлена сметами, поэтому два
 * признака и запрет обвязки. Сканы отчётов и извещения Роснедра геологические целиком:
 * при пороге 2 из 1476 кусков сканов проходил 31, и выборка выродилась бы в один жанр
 * («отчёт, где считают скважины»), а нужны и те куски, где геология описана словами.
 */
const geoHint = (t: string, min: number) =>
  !NOT_GEO.test(t) && GEO_HINTS.filter((re) => re.test(t)).length >= min;

type Chunk = {
  chunk_id: string;
  corpus: string;
  doc_id: string;
  offset: number;
  tier: "A" | "B";
  text: string;
};

/** Режем по переводу строки, чтобы не рвать таблицу посреди строки. */
function cut(text: string, size: number): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + size * 0.5) end = nl;
    }
    out.push({ offset: i, text: text.slice(i, end) });
    i = end;
  }
  return out;
}

const PLAN: { corpus: string; file: string; tierB: number; tierA: number; minHints: number }[] = [
  // 584 закупки ЕИС «геологического» семейства — тот же корпус, на котором мерили 04.08
  // (сравнимость). Геология в нём разбавлена сметами и шаблонами контрактов, отсюда меньшая доля.
  { corpus: "eis-geo", file: ".corpus/texts.jsonl", tierB: 60, tierA: 10, minHints: 2 },
  // 369 распознанных геологических отчётов — другой жанр (сканы, шум распознавания).
  { corpus: "scans", file: ".corpus/scans.jsonl", tierB: 90, tierA: 10, minHints: 1 },
  // 150 извещений Роснедра — жанр, где лицензии и имена участков идут плотно.
  { corpus: "rosnedra", file: ".corpus/rosnedra.jsonl", tierB: 40, tierA: 10, minHints: 1 },
];

const chunks: Chunk[] = [];
for (const p of PLAN) {
  const docs = readFileSync(p.file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { doc_id: string; text: string });

  const all: Chunk[] = [];
  for (const d of shuffle(docs)) {
    for (const c of cut(d.text, CHUNK)) {
      if (c.text.trim().length < 400) continue;
      all.push({
        chunk_id: `${p.corpus}:${d.doc_id.slice(0, 24)}:${c.offset}`,
        corpus: p.corpus,
        doc_id: d.doc_id,
        offset: c.offset,
        tier: "A",
        text: c.text,
      });
    }
  }

  // Не больше двух кусков из одного документа: иначе выборку съедает один длинный отчёт.
  // И один и тот же кусок не берём дважды: слой A выбирается из общего пула, куда уже попали
  // куски слоя B, и без этой проверки часть «представительного» слоя оказывалась копией
  // «обогащённого» (в прогоне 05.08 так задвоились 10 кусков из 220).
  const perDoc = new Map<string, number>();
  const taken = new Set<string>();
  const take = (pool: Chunk[], n: number, tier: "A" | "B") => {
    const out: Chunk[] = [];
    for (const c of pool) {
      if (out.length >= n) break;
      if (taken.has(c.chunk_id)) continue;
      const used = perDoc.get(c.doc_id) ?? 0;
      if (used >= 2) continue;
      perDoc.set(c.doc_id, used + 1);
      taken.add(c.chunk_id);
      out.push({ ...c, tier });
    }
    return out;
  };

  const shuffled = shuffle(all);
  chunks.push(...take(shuffled.filter((c) => geoHint(c.text, p.minHints)), p.tierB, "B"));
  chunks.push(...take(shuffled, p.tierA, "A"));
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");

const by = (k: (c: Chunk) => string) =>
  chunks.reduce<Record<string, number>>((a, c) => ((a[k(c)] = (a[k(c)] ?? 0) + 1), a), {});
console.log(`кусков: ${chunks.length}, знаков: ${chunks.reduce((s, c) => s + c.text.length, 0).toLocaleString("ru")}`);
console.log("по корпусам:", by((c) => c.corpus));
console.log("по слоям:   ", by((c) => c.tier));
console.log(`→ ${OUT}`);
