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
import { detectEntities as detectRules, resolveOverlaps } from "../src/deid/detect";
import { spreadGeoNames } from "../src/deid/geo-spread";

/** Повторяет боевой конвейер: правила + протяжка гео-имени (см. components/text-deid.ts). */
const detectEntities = (text: string, types: Parameters<typeof detectRules>[1]) => {
  const ents = detectRules(text, types);
  return types.includes("GEO_NAME") ? resolveOverlaps([...ents, ...spreadGeoNames(text, ents)]) : ents;
};
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

/**
 * Сколько даст ПРОТЯЖКА гео-имени по документу (как spread.ts тянет личность).
 *
 * Имя, подтверждённое ключевым словом («Нямдинская площадь», «месторождение Ихала»),
 * дальше в том же документе упоминается голым: «на Нямдинской», «в пределах Ихалы».
 * Правилу такое вхождение взять неоткуда — контекста рядом нет. Считаем, сколько таких
 * вхождений остаётся открытым, чтобы понять, стоит ли протяжка работы.
 */
const GEO_KEY_WORDS =
  /(?:^|\s)(?:месторождени[а-яё]*|проявлени[а-яё]*|участк[а-яё]*|участок|площад[а-яё]*|рек[аиеуой]|р\.|уч\.|недр)(?=\s|$)/giu;
/** Основа имени без падежного окончания: «Нямдинской» → «нямдинск». */
function nameStem(word: string): string | null {
  const w = word.replace(/[«»"',.;:()]/g, "");
  if (w.length < 5 || !/^[А-ЯЁ]/u.test(w)) return null;
  const stem = w.replace(/(?:ого|его|ому|ему|ыми|ими|ская|ской|ские|ских|ое|ая|ый|ий|ой|ые|ие|ых|их|ым|им|ом|ем|ей|ую|юю|а|у|е|ы|и)$/u, "");
  return stem.length >= 4 ? stem.toLowerCase() : null;
}

function runSpread(docs: { text: string }[]): Item[] {
  const types = entitiesForVertical("geo");
  const out: Item[] = [];
  for (const doc of docs) {
    const hits = detectEntities(doc.text, types).filter((e) => e.type === "GEO_NAME");
    if (!hits.length) continue;
    const stems = new Set<string>();
    for (const h of hits) {
      // Гидроним не тянем: реки называют по городам («р. Москва»), и протяжка ушла бы
      // на сам город — а область, край и столица по решению владельца не маскируются.
      if (/^(?:р\.|рек)/iu.test(h.raw)) continue;
      for (const w of h.raw.replace(GEO_KEY_WORDS, " ").split(/\s+/)) {
        const s = nameStem(w);
        if (s) stems.add(s);
      }
    }
    if (!stems.size) continue;
    // Тот же ограничитель, что у протяжки личности: слово, которое в ЭТОМ ЖЕ документе
    // встречается со строчной, — обычное слово, а не имя. «Проектной», «земельного»
    // стоят с заглавной только в начале предложения, и без этой проверки протяжка
    // размножала бы ложняк на весь документ (182 и 57 вхождений на корпусе ЕИС).
    for (const s of [...stems]) {
      const lower = new RegExp(`(?<![А-ЯЁа-яё])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[а-яё]{0,4}(?![А-ЯЁа-яё])`, "gu");
      if (lower.test(doc.text)) stems.delete(s);
    }
    if (!stems.size) continue;
    const masked = maskDetected(doc.text, detectEntities(doc.text, types));
    for (const s of stems) {
      const re = new RegExp(`(?<![А-ЯЁа-яё])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[а-яё]{0,4}(?![А-ЯЁа-яё])`, "giu");
      for (const m of masked.matchAll(re)) {
        const i = m.index ?? 0;
        out.push({
          value: `${s}\t${m[0].toLowerCase()}`,
          ctx: masked.slice(Math.max(0, i - 50), i + m[0].length + 50).replace(/\s+/g, " "),
        });
      }
    }
  }
  return out;
}

/**
 * Сверка со СТОРОННИМ справочником топонимов — метки не наши.
 *
 * Зачем. Полнота и точность GEO_NAME до сих пор считались по РУЧНОЙ разметке форм, и делал
 * её тот же, кто правил детектор. Цифра может быть верной, но подтверждения у неё нет.
 * Справочник GeoNames (CC BY, ~250 тыс. российских топонимов) в нашей работе не участвовал
 * и потому годится как независимый судья.
 *
 * Что считаем. Три числа, и каждое отвечает на свой вопрос:
 *   • находка ЕСТЬ в справочнике → настоящее название, детектор прав;
 *   • находки НЕТ в справочнике → кандидат в ложняк (или объект, которого нет в GeoNames:
 *     мелкие участки недр туда не попадают, поэтому это верхняя оценка ошибки, не точная);
 *   • кандидат сети остался ОТКРЫТЫМ, но ЕСТЬ в справочнике → пропуск, подтверждённый
 *     со стороны. Вот это самое ценное: своей разметке тут верить не нужно.
 *
 * Сверяем по ОСНОВЕ: в справочнике именительный падеж («Китой», «Нямдинская»), у нас
 * падежные формы и прилагательные. Стеммер тут СВОЙ, а не из src/: судья, пользующийся
 * внутренностями подсудимого, независимым быть перестаёт.
 *
 * ГРАНИЦЫ, ЗАМЕРЕННЫЕ 05.08 — читать до того, как поверить цифре:
 *   • справочник НЕ СОДЕРЖИТ названий лицензионных участков вида «Нямдинская»,
 *     «Кирьяволахтинская», «Куроптевская» — это не классические геообъекты, GeoNames их
 *     как класс не описывает. Ручная проверка 29 наших названий: 20 точных совпадений и
 *     3 в другой форме, но из 7 прилагательных на «-ская/-ское» НИ ОДНОГО. Поэтому
 *     «находка вне справочника» для этого класса ложняком НЕ является;
 *   • обратная ошибка тоже есть: обычные слова, случайно совпавшие с названием посёлка
 *     («Раздел», «Российский», «Чувашская»), справочник «подтверждает»;
 *   • короткие имена («Урал», «Зея», «Хета») не проходят порог длины основы.
 * Итог: судья годится для РЕК и НАСЕЛЁННЫХ ПУНКТОВ и не годится для участков недр —
 * то есть ровно там, где наша точность слабее всего, независимых меток он не даёт.
 * Цифры ниже — вспомогательные, публиковать их как оценку качества нельзя.
 */
/** Ключевые слова гео-правил: они есть в любой находке и опознавателями НЕ являются. */
// Кириллицу `\w` в JavaScript НЕ покрывает (это [A-Za-z0-9_]) — из-за этого первая
// версия фильтра не срабатывала вовсе, ключевые слова доходили до сверки и справочник
// «подтверждал» пропуски вида «участка провести».
const JUDGE_KEYWORDS =
  /^(?:участ[а-яё]*|площад[а-яё]*|месторожден[а-яё]*|проявлен[а-яё]*|недр[а-яё]*|рек[а-яё]*|р|уч|скважин[а-яё]*|объект[а-яё]*)$/iu;

/**
 * Мягкое усечение: снимаем НЕ БОЛЕЕ ОДНОГО окончания и оставляем не короче пяти знаков.
 * Первая версия резала жадно и в цикле — «Китой» превращался в «кит», отбрасывался по
 * длине, и справочник переставал подтверждать реку, которая в нём заведомо есть. Заодно
 * общие стволы вроде «участ» начинали совпадать со всем подряд, и судья «подтверждал»
 * пропуски вида «участка провести». Судья, который так ошибается, хуже отсутствия судьи.
 */
function judgeStem(word: string): string | null {
  const w = word.replace(/[«»"',.;:()№]/gu, "").trim();
  if (!/^[А-ЯЁ]/u.test(w) || JUDGE_KEYWORDS.test(w)) return null;
  const lower = w.toLowerCase();
  const cut = lower.replace(/(?:ского|ская|ской|ские|ских|ого|его|ому|ему|ыми|ими|ая|ое|ый|ий|ые|ие|ых|их|ым|им|ом|ем|ей|ую|юю|а|у|е|ы|и|ь)$/u, "");
  const stem = cut.length >= 5 ? cut : lower;
  return stem.length >= 5 ? stem : null;
}

function loadGazetteer(path: string): Set<string> {
  const out = new Set<string>();
  try {
    const raw = require("node:fs").readFileSync(path, "utf8") as string;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const name = JSON.parse(line).name as string;
      for (const part of String(name).split(/[\s-]+/u)) {
        const s = judgeStem(part);
        if (s) out.add(s);
      }
    }
  } catch {
    return out;
  }
  return out;
}

function runJudge(docs: { text: string }[]): Item[] {
  const types = entitiesForVertical("geo");
  const out: Item[] = [];
  for (const doc of docs) {
    for (const e of detectEntities(doc.text, types)) {
      if (e.type !== "GEO_NAME") continue;
      out.push({ value: `находка\t${e.raw.replace(/\s+/gu, " ").trim().toLowerCase()}`, ctx: "" });
    }
    const masked = maskDetected(doc.text, detectEntities(doc.text, types));
    for (const m of geoNetMatches("GEO_NAME", masked)) {
      if (/\[[A-Z_]{3,}\]/.test(m.value)) continue;
      out.push({ value: `открыто\t${m.value.replace(/\s+/gu, " ").trim().toLowerCase()}`, ctx: "" });
    }
  }
  return out;
}

const RUN = {
  measure: runMeasure,
  misses: runMisses,
  hits: runHits,
  net: runNet,
  spread: runSpread,
  judge: runJudge,
} as const;

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
} else if (mode === "judge") {
  const gazPath = arg("gazetteer", ".corpus/gazetteer-ru.jsonl")!;
  const gaz = loadGazetteer(gazPath);
  if (!gaz.size) {
    console.log(`справочник не прочитан: ${gazPath} — сверять не с чем`);
    process.exit(2);
  }
  const inGaz = (form: string): boolean =>
    form.split(/\s+/u).some((w) => {
      const s = judgeStem(w.charAt(0).toUpperCase() + w.slice(1));
      return s ? gaz.has(s) : false;
    });

  const tally = { находкаПодтв: 0, находкаНет: 0, открытоПодтв: 0, открытоНет: 0 };
  const examples = { находкаНет: new Map<string, number>(), открытоПодтв: new Map<string, number>() };
  for (const it of (parts as Item[][]).flat()) {
    const [kind, form] = it.value.split("\t") as [string, string];
    const hit = inGaz(form);
    if (kind === "находка") {
      if (hit) tally.находкаПодтв += 1;
      else {
        tally.находкаНет += 1;
        examples.находкаНет.set(form, (examples.находкаНет.get(form) ?? 0) + 1);
      }
    } else if (hit) {
      tally.открытоПодтв += 1;
      examples.открытоПодтв.set(form, (examples.открытоПодтв.get(form) ?? 0) + 1);
    } else tally.открытоНет += 1;
  }
  const hits = tally.находкаПодтв + tally.находкаНет;
  console.log(`справочник: ${gaz.size} основ | документов ${docs.length} | время ${secs} с`);
  console.log(
    "ВНИМАНИЕ: справочник не знает названий лицензионных участков («Нямдинская», «Куроптевская»)\n" +
      "и «подтверждает» обычные слова, совпавшие с посёлками. Цифры вспомогательные — см. шапку runJudge.\n",
  );
  console.log(`находок детектора        ${hits}`);
  console.log(`  подтверждено справочником ${tally.находкаПодтв}  (${((100 * tally.находкаПодтв) / (hits || 1)).toFixed(1)}%)`);
  console.log(`  справочник не знает       ${tally.находкаНет}  ← кандидаты в ложняк (верхняя оценка)`);
  console.log(`осталось открытым        ${tally.открытоПодтв + tally.открытоНет}`);
  console.log(`  ЕСТЬ в справочнике        ${tally.открытоПодтв}  ← пропуски, подтверждённые СО СТОРОНЫ`);
  console.log(`  справочник не знает       ${tally.открытоНет}  (скорее всего и не названия)`);
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([f, c]) => `${c}× ${f}`).join("; ");
  console.log(`\nпропуски, подтверждённые справочником: ${top(examples.открытоПодтв, 20) || "нет"}`);
  console.log(`\nнаходки вне справочника: ${top(examples.находкаНет, 20) || "нет"}`);
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
