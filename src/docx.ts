/**
 * DOCX: де-идентификация и возврат оригиналов.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ «ЗАМЕНА ПО ФАЙЛУ». Внутри .docx текст лежит не строкой, а
 * россыпью узлов `<w:t>`: Word свободно рвёт слово на несколько прогонов после правки,
 * проверки орфографии или смены языка, так что «Иванов И.И.» вполне может храниться как
 * `<w:t>Иван</w:t><w:t>ов И.И.</w:t>`. Замена по каждому узлу отдельно такую фамилию
 * не увидит и выпустит её наружу; замена по всему XML — испортит разметку. Поэтому текст
 * абзаца склеивается, ищется на склейке, а подстановка идёт ПО КООРДИНАТАМ обратно в те же
 * узлы — форматирование всех незатронутых прогонов сохраняется.
 *
 * ГДЕ ЕЩЁ ЖИВУТ ПЕРСОНАЛЬНЫЕ ДАННЫЕ, кроме основного текста (всё это обрабатывается):
 *   • колонтитулы — подписи исполнителей чаще всего именно там;
 *   • сноски, концевые сноски, примечания;
 *   • свойства документа: `dc:creator`, `cp:lastModifiedBy`, `Company`, `Manager`;
 *   • атрибут `w:author` у правок рецензирования и примечаний — имя автора правки;
 *   • `w:delText` — удалённый в режиме правок текст, который остаётся в файле.
 *
 * ЧЕСТНЫЙ ПРЕДЕЛ: вложенные объекты (`word/embeddings/*`) не разбираются — внедрённую
 * книгу Excel нужно прогонять через `xlsx.ts` отдельно. `assertDocxContainsNone` об этом
 * не умалчивает: она проверяет только XML-части.
 */

import JSZip from "jszip";
import { tokenizeEntities } from "./components/text-deid";
import { detectEntities } from "./deid/detect";
import { entitiesForVertical, type EntityType, type Vertical } from "./deid/entities";
import type { HideOperator } from "./deid/operators";
import type { MorphAdapter } from "./deid/morph";
import { restoreSpans, type RestoreOpts } from "./deid/restore";
import type { TokenVault } from "./vault";

export interface DocxResult {
  bytes: Uint8Array;
  replacements: number;
}

/** Участок склеенного текста и то, что должно встать на его место. */
interface Span {
  start: number;
  end: number;
  replacement: string;
}

type SpanSource = (text: string) => Span[];

/** Части с основным текстом. Пропуск любой из них — это утечка, а не косметика. */
const TEXT_PARTS =
  /^word\/(?:document\.xml|header\d*\.xml|footer\d*\.xml|footnotes\.xml|endnotes\.xml|comments\.xml|commentsExtended\.xml|glossary\/document\.xml)$/u;

/** Свойства документа: автор, кто менял последним, организация, руководитель. */
const PROPS_PARTS = /^docProps\/(?:core|app)\.xml$/u;

/** Реестр авторов примечаний Word 2013+. */
const PEOPLE_PART = /^word\/people\.xml$/u;

/** Текстовые узлы: обычный текст и текст, удалённый в режиме правок. */
const TEXT_NODE_RE = /<(w:t|w:delText)((?:\s[^>]*)?)>([^<]*)<\/\1>/gu;

/** Абзац — граница склейки: между абзацами слово не рвётся, а имена соседних строк слипаться не должны. */
const PARAGRAPH_END = "</w:p>";

/** Атрибуты с именами людей. */
const AUTHOR_ATTRS = ["w:author", "w15:author", "w16cid:author"];

/** Теги свойств документа, содержащие ПДн. */
const PROPS_TAGS = ["dc:creator", "cp:lastModifiedBy", "Company", "Manager", "w15:person"];

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXml(value).replace(/"/gu, "&quot;");
}

/** Узел текста внутри одного куска XML: где лежит содержимое и каким оно было. */
interface TextNode {
  /** Границы СОДЕРЖИМОГО (без тегов) в исходной строке XML. */
  xmlStart: number;
  xmlEnd: number;
  /** Границы этого узла в склеенном тексте абзаца. */
  from: number;
  to: number;
  text: string;
  /** Позиция и длина атрибутов открывающего тега — для добавления xml:space. */
  attrsAt: number;
  attrs: string;
}

function collectNodes(xml: string): { nodes: TextNode[]; joined: string } {
  const nodes: TextNode[] = [];
  let joined = "";
  for (const match of xml.matchAll(TEXT_NODE_RE)) {
    const [full, tag, attrs, raw] = match as unknown as [string, string, string, string];
    const contentStart = match.index! + `<${tag}${attrs}>`.length;
    const text = unescapeXml(raw);
    nodes.push({
      xmlStart: contentStart,
      xmlEnd: contentStart + raw.length,
      from: joined.length,
      to: joined.length + text.length,
      text,
      attrsAt: match.index! + 1 + tag.length,
      attrs,
    });
    joined += text;
    void full;
  }
  return { nodes, joined };
}

/**
 * Раскладывает замены обратно по узлам.
 *
 * Замена, попавшая внутрь одного узла, там и остаётся. Замена, разорванная между узлами,
 * целиком уходит в ПЕРВЫЙ затронутый узел, а из остальных вырезается покрытая часть:
 * форматирование самой сущности при этом берётся от её начала, а всё остальное в абзаце
 * не двигается вовсе.
 */
function applyToNodes(xml: string, nodes: TextNode[], spans: Span[]): string {
  if (!spans.length) return xml;
  const updated = new Map<number, string>();
  for (const [index, node] of nodes.entries()) {
    const covering = spans.filter((s) => s.start < node.to && node.from < s.end);
    if (!covering.length) continue;
    let text = "";
    let cursor = node.from;
    for (const span of covering) {
      if (span.start > cursor) text += node.text.slice(cursor - node.from, span.start - node.from);
      // Замену целиком кладём в первый узел, который её начинает.
      if (span.start >= node.from) text += span.replacement;
      cursor = Math.max(cursor, Math.min(span.end, node.to));
    }
    if (cursor < node.to) text += node.text.slice(cursor - node.from);
    updated.set(index, text);
  }

  let out = "";
  let cursor = 0;
  for (const [index, node] of nodes.entries()) {
    const text = updated.get(index);
    if (text === undefined) continue;
    let head = xml.slice(cursor, node.xmlStart);
    // Пробел по краям Word отбрасывает, если не сказано обратное.
    if (/^\s|\s$/u.test(text) && !node.attrs.includes("xml:space")) {
      const insertAt = node.attrsAt - cursor;
      head = `${head.slice(0, insertAt)} xml:space="preserve"${head.slice(insertAt)}`;
    }
    out += head + escapeXml(text);
    cursor = node.xmlEnd;
  }
  return out + xml.slice(cursor);
}

/** Обрабатывает XML части по абзацам: склейка → поиск → подстановка по координатам. */
function rewriteXml(xml: string, spansOf: SpanSource): { xml: string; replacements: number } {
  let out = "";
  let replacements = 0;
  let cursor = 0;
  while (cursor <= xml.length) {
    const boundary = xml.indexOf(PARAGRAPH_END, cursor);
    const end = boundary < 0 ? xml.length : boundary + PARAGRAPH_END.length;
    const chunk = xml.slice(cursor, end);
    const { nodes, joined } = collectNodes(chunk);
    if (nodes.length) {
      const spans = spansOf(joined);
      replacements += spans.length;
      out += applyToNodes(chunk, nodes, spans);
    } else {
      out += chunk;
    }
    if (boundary < 0) break;
    cursor = end;
  }
  return { xml: out, replacements };
}

/** Заменяет значения перечисленных атрибутов (авторы правок и примечаний). */
function rewriteAttributes(xml: string, names: string[], spansOf: SpanSource): {
  xml: string;
  replacements: number;
} {
  let replacements = 0;
  const pattern = new RegExp(`(${names.join("|")})="([^"]*)"`, "gu");
  const out = xml.replace(pattern, (full, name: string, value: string) => {
    const decoded = unescapeXml(value);
    const spans = spansOf(decoded);
    if (!spans.length) return full;
    replacements += spans.length;
    let text = "";
    let cursor = 0;
    for (const span of spans) {
      text += decoded.slice(cursor, span.start) + span.replacement;
      cursor = span.end;
    }
    return `${name}="${escapeXmlAttr(text + decoded.slice(cursor))}"`;
  });
  return { xml: out, replacements };
}

/** Заменяет содержимое тегов свойств документа. */
function rewriteSimpleTags(xml: string, tags: string[], spansOf: SpanSource): {
  xml: string;
  replacements: number;
} {
  let replacements = 0;
  const pattern = new RegExp(
    `<(${tags.join("|")})((?:\\s[^>]*)?)>([^<]*)</\\1>`,
    "gu",
  );
  const out = xml.replace(pattern, (full, tag: string, attrs: string, raw: string) => {
    const decoded = unescapeXml(raw);
    const spans = spansOf(decoded);
    if (!spans.length) return full;
    replacements += spans.length;
    let text = "";
    let cursor = 0;
    for (const span of spans) {
      text += decoded.slice(cursor, span.start) + span.replacement;
      cursor = span.end;
    }
    return `<${tag}${attrs}>${escapeXml(text + decoded.slice(cursor))}</${tag}>`;
  });
  return { xml: out, replacements };
}

async function rewriteDocx(
  input: Uint8Array,
  spansOf: SpanSource,
): Promise<{ zip: JSZip; replacements: number }> {
  const zip = await JSZip.loadAsync(input);
  let replacements = 0;

  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]!;
    if (entry.dir) continue;
    const isText = TEXT_PARTS.test(name);
    const isProps = PROPS_PARTS.test(name);
    const isPeople = PEOPLE_PART.test(name);
    if (!isText && !isProps && !isPeople) continue;

    let xml = await entry.async("string");
    if (isText) {
      const body = rewriteXml(xml, spansOf);
      xml = body.xml;
      replacements += body.replacements;
    }
    if (isText || isPeople) {
      const authors = rewriteAttributes(xml, AUTHOR_ATTRS, spansOf);
      xml = authors.xml;
      replacements += authors.replacements;
    }
    if (isProps) {
      const props = rewriteSimpleTags(xml, PROPS_TAGS, spansOf);
      xml = props.xml;
      replacements += props.replacements;
    }
    zip.file(name, xml);
  }

  return { zip, replacements };
}

/**
 * Прячет персональные данные в DOCX. Соответствие «что было ↔ что стало» остаётся в сейфе
 * на машине клиента; наружу уходит только обработанный файл.
 */
export async function deidentifyDocx(
  input: Uint8Array,
  vault: TokenVault,
  opts: {
    vertical: Vertical;
    types?: EntityType[];
    operator?: HideOperator;
    morph?: MorphAdapter;
  },
): Promise<DocxResult> {
  const types = opts.types ?? entitiesForVertical(opts.vertical);
  const originals = new Set<string>();

  const spansOf: SpanSource = (text) => {
    const spans: Span[] = [];
    for (const entity of detectEntities(text, types)) {
      const { text: surface } = tokenizeEntities(entity.raw, [{ ...entity, index: 0 }], vault, {
        operator: opts.operator,
        morph: opts.morph,
      });
      originals.add(entity.raw);
      spans.push({
        start: entity.index,
        end: entity.index + entity.raw.length,
        replacement: surface,
      });
    }
    return spans;
  };

  const { zip, replacements } = await rewriteDocx(input, spansOf);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await assertDocxContainsNone(bytes, originals);
  return { bytes, replacements };
}

/**
 * Возвращает оригиналы в готовый DOCX — тот самый случай, ради которого всё это нужно:
 * модель собрала отчёт с ярлыками, а клиент получает документ с настоящими именами,
 * не отправив ни одного из них наружу.
 */
export async function reidentifyDocx(
  input: Uint8Array,
  vault: TokenVault,
  opts?: RestoreOpts,
): Promise<DocxResult> {
  const spansOf: SpanSource = (text) => restoreSpans(text, vault, opts).spans;
  const { zip, replacements } = await rewriteDocx(input, spansOf);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, replacements };
}

/**
 * Проверяет, что в файле не осталось исходных значений. Смотрит ВСЕ XML-части, включая
 * колонтитулы, сноски, примечания и свойства документа, и учитывает XML-экранирование.
 *
 * Предел честно ограничен разметкой: вложенные бинарные объекты (`word/embeddings/*`,
 * картинки со сканами) этой проверкой не покрываются.
 */
export async function assertDocxContainsNone(
  bytes: Uint8Array,
  forbidden: Iterable<string>,
): Promise<void> {
  const values = [...new Set(forbidden)].filter(Boolean);
  if (!values.length) return;
  const zip = await JSZip.loadAsync(bytes);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/\.(?:xml|rels)$/u.test(name)) continue;
    const xml = await entry.async("string");
    const decoded = unescapeXml(xml);
    const leaked = values.find((value) => xml.includes(value) || decoded.includes(value));
    if (leaked) throw new Error(`DOCX содержит исходное значение в ${name}`);
  }
}
