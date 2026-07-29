import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import { assertPdfContainsNone, extractPdfText, findPdfPlaceholders } from "./pdf";

/** Кириллица в однобайтовой кодировке PDF (WinAnsi/CP1251). */
function toCp1251(value: string): Buffer {
  return Buffer.from(
    [...value].map((char) => {
      const code = char.charCodeAt(0);
      if (code >= 0x410 && code <= 0x44f) return code - 0x350;
      if (code === 0x401) return 0xa8;
      if (code === 0x451) return 0xb8;
      return code & 0xff;
    }),
  );
}

/** Кириллица как UTF-16BE с BOM — второй типовой способ. */
function toUtf16(value: string): Buffer {
  const bytes: number[] = [0xfe, 0xff];
  for (const char of value) {
    const code = char.charCodeAt(0);
    bytes.push(code >> 8, code & 0xff);
  }
  return Buffer.from(bytes);
}

/** Минимальный PDF с одним содержательным потоком. */
function buildPdf(content: Buffer, opts?: { compress?: boolean; author?: string }): Uint8Array {
  const body = opts?.compress ? deflateSync(content) : content;
  const head = Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Length ${body.length} ${opts?.compress ? "/Filter /FlateDecode" : ""} >>\nstream\n`,
    "latin1",
  );
  // Кириллица в /Author физически может лежать только в UTF-16BE — как её и пишут генераторы.
  const info = opts?.author
    ? Buffer.concat([
        Buffer.from("2 0 obj\n<< /Author (", "latin1"),
        toUtf16(opts.author),
        Buffer.from(") >>\nendobj\n", "latin1"),
      ])
    : Buffer.alloc(0);
  const tail = Buffer.from("\nendstream\nendobj\n", "latin1");
  const trailer = Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF", "latin1");
  return new Uint8Array(Buffer.concat([head, body, tail, info, trailer]));
}

function textOperator(encoded: Buffer): Buffer {
  return Buffer.concat([Buffer.from("BT /F1 12 Tf (", "latin1"), encoded, Buffer.from(") Tj ET", "latin1")]);
}

describe("privacy/pdf: извлечение текста", () => {
  it("читает однобайтовую кириллицу", () => {
    const pdf = buildPdf(textOperator(toCp1251("Отчёт подписал Иванов И.П.")));
    expect(extractPdfText(pdf)).toContain("Иванов И.П.");
  });

  it("читает UTF-16BE и сжатый поток", () => {
    const pdf = buildPdf(textOperator(toUtf16("Согласовал Тер-Петросян А.Б.")), { compress: true });
    expect(extractPdfText(pdf)).toContain("Тер-Петросян А.Б.");
  });
});

describe("privacy/pdf: проверка собранного артефакта", () => {
  it("ловит исходное значение в тексте страницы", () => {
    const pdf = buildPdf(textOperator(toCp1251("Пробы отобрал Ким П.С.")));
    expect(() => assertPdfContainsNone(pdf, ["Ким П.С."])).toThrow(/исходное значение/u);
    expect(() => assertPdfContainsNone(pdf, ["Петров А.В."])).not.toThrow();
  });

  it("ловит исходное значение в сжатом потоке", () => {
    const pdf = buildPdf(textOperator(toUtf16("Исполнитель Оганесян А.Р.")), { compress: true });
    expect(() => assertPdfContainsNone(pdf, ["Оганесян А.Р."])).toThrow(/исходное значение/u);
  });

  it("ловит имя в свойствах документа, а не только на странице", () => {
    // /Author лежит вне страничных потоков — типовое место утечки при сборке отчёта.
    const pdf = buildPdf(textOperator(toCp1251("Текст без имён")), {
      author: "Гончарук И.П.",
    });
    expect(() => assertPdfContainsNone(pdf, ["Гончарук И.П."])).toThrow(/исходное значение/u);
  });

  it("находит неподставленные ярлыки в готовом файле", () => {
    const pdf = buildPdf(textOperator(toCp1251("Отчёт подготовил [PER_01] для [ORG_02]")));
    expect(findPdfPlaceholders(pdf).sort()).toEqual(["[ORG_02]", "[PER_01]"]);
    expect(findPdfPlaceholders(buildPdf(textOperator(toCp1251("Всё подставлено"))))).toEqual([]);
  });
});
