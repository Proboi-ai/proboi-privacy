import { describe, expect, it } from "bun:test";
import JSZip from "jszip";
import { assertDocxContainsNone, deidentifyDocx, reidentifyDocx } from "./docx";
import { createLocalMorphAdapter } from "./deid/morph";
import { createSurrogateOperator } from "./deid/operators";
import { TokenVault } from "./vault";

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

/** Прогон текста с необязательным форматированием. */
function run(text: string, bold = false): string {
  return `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t>${text}</w:t></w:r>`;
}

function paragraph(...runs: string[]): string {
  return `<w:p>${runs.join("")}</w:p>`;
}

function document(...paragraphs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}</w:body></w:document>`;
}

async function buildDocx(parts: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generateAsync({ type: "uint8array" });
}

async function partOf(bytes: Uint8Array, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(name)!.async("string");
}

/** Текст документа так, как его увидит Word: содержимое всех <w:t> подряд. */
async function textOf(bytes: Uint8Array, name = "word/document.xml"): Promise<string> {
  const xml = await partOf(bytes, name);
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu)].map((m) => m[1]).join("");
}

const GEO = { vertical: "geo" } as const;

describe("privacy/docx: де-идентификация", () => {
  it("ловит фамилию, разорванную между прогонами", async () => {
    // Word рвёт слово после правки орфографии — по одному <w:t> такую фамилию не найти.
    const input = await buildDocx({
      "word/document.xml": document(
        paragraph(run("Отчёт составил Иван"), run("ов И.П. лично")),
      ),
    });
    const vault = new TokenVault();
    const { bytes, replacements } = await deidentifyDocx(input, vault, GEO);

    expect(replacements).toBe(1);
    expect(await textOf(bytes)).toBe("Отчёт составил [PER_01] лично");
    expect(vault.original("[PER_01]")).toBe("Иванов И.П.");
  });

  it("не трогает форматирование соседних прогонов", async () => {
    const input = await buildDocx({
      "word/document.xml": document(
        paragraph(run("ЗАКЛЮЧЕНИЕ", true), run(". Подготовил Петров А.В.")),
      ),
    });
    const xml = await partOf((await deidentifyDocx(input, new TokenVault(), GEO)).bytes, "word/document.xml");

    expect(xml).toContain("<w:rPr><w:b/></w:rPr><w:t>ЗАКЛЮЧЕНИЕ</w:t>");
    expect(xml).toContain("[PER_01]");
  });

  it("обрабатывает колонтитул, сноску и свойства документа", async () => {
    const input = await buildDocx({
      "word/document.xml": document(paragraph(run("Основной текст"))),
      "word/header1.xml": document(paragraph(run("Исполнитель: Сидоров П.И."))),
      "word/footnotes.xml": document(paragraph(run("Данные предоставил Ким О.С."))),
      "docProps/core.xml":
        '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Тер-Петросян А.Б.</dc:creator><cp:lastModifiedBy>Гончарук И.П.</cp:lastModifiedBy></cp:coreProperties>',
    });
    const vault = new TokenVault();
    const { bytes } = await deidentifyDocx(input, vault, GEO);

    expect(await textOf(bytes, "word/header1.xml")).toContain("[PER_");
    expect(await textOf(bytes, "word/footnotes.xml")).toContain("[PER_");
    const props = await partOf(bytes, "docProps/core.xml");
    expect(props).not.toContain("Тер-Петросян");
    expect(props).not.toContain("Гончарук");
  });

  it("прячет автора правки рецензирования", async () => {
    const input = await buildDocx({
      "word/document.xml": document(
        `<w:p><w:ins w:id="1" w:author="Оганесян А.Р." w:date="2026-07-29T10:00:00Z">${run("вставленный текст")}</w:ins></w:p>`,
      ),
    });
    const xml = await partOf((await deidentifyDocx(input, new TokenVault(), GEO)).bytes, "word/document.xml");

    expect(xml).not.toContain("Оганесян");
    expect(xml).toContain('w:author="[PER_01]"');
  });

  it("сохраняет пробелы по краям заменённого узла", async () => {
    const input = await buildDocx({
      "word/document.xml": document(paragraph(run("Иванов И.П. "), run("подписал"))),
    });
    const xml = await partOf((await deidentifyDocx(input, new TokenVault(), GEO)).bytes, "word/document.xml");

    expect(xml).toContain('xml:space="preserve"');
    expect(await textOf((await deidentifyDocx(input, new TokenVault(), GEO)).bytes))
      .toBe("[PER_01] подписал");
  });

  it("падает, если исходное значение осталось в файле", async () => {
    const bytes = await buildDocx({
      "word/document.xml": document(paragraph(run("Иванов И.П."))),
    });
    await expect(assertDocxContainsNone(bytes, ["Иванов И.П."])).rejects.toThrow(
      /исходное значение/u,
    );
    await expect(assertDocxContainsNone(bytes, ["Петров А.В."])).resolves.toBeUndefined();
  });
});

describe("privacy/docx: возврат оригиналов", () => {
  it("круговой рейс возвращает исходный текст", async () => {
    const source = document(
      paragraph(run("Отчёт составил Иван"), run("ов И.П.")),
      paragraph(run("Согласовано: Тер-Петросян А.Б.")),
    );
    const input = await buildDocx({ "word/document.xml": source });
    const vault = new TokenVault();

    const hidden = await deidentifyDocx(input, vault, GEO);
    const restored = await reidentifyDocx(hidden.bytes, vault, { fuzzy: true });

    expect(await textOf(restored.bytes)).toBe(
      "Отчёт составил Иванов И.П.Согласовано: Тер-Петросян А.Б.",
    );
  });

  it("возвращает оригинал, если модель просклоняла суррогат в собранном документе", async () => {
    const morph = createLocalMorphAdapter();
    const vault = new TokenVault();
    const token = vault.tokenFor("PER", "Иванов И.П.");
    vault.setSurface(token, { surface: "Петров А.В.", morph: { gender: "masc" } });

    // Так выглядит документ, собранный моделью: она склоняет выданное ей имя.
    const assembled = await buildDocx({
      "word/document.xml": document(paragraph(run("Задание направлено Петрову А.В."))),
    });
    const { bytes } = await reidentifyDocx(assembled, vault, { fuzzy: true });

    expect(await textOf(bytes)).toBe("Задание направлено Иванову И.П.");
    void morph;
  });

  it("суррогатный режим: документ читается как настоящий, и возвращается в исходный", async () => {
    const morph = createLocalMorphAdapter();
    const operator = createSurrogateOperator({ morph });
    const vault = new TokenVault();
    const input = await buildDocx({
      "word/document.xml": document(paragraph(run("Пробы отобрал Ким П.С. на участке"))),
    });

    const hidden = await deidentifyDocx(input, vault, { ...GEO, operator, morph });
    const hiddenText = await textOf(hidden.bytes);
    expect(hiddenText).not.toContain("Ким П.С.");
    expect(hiddenText).not.toContain("[PER_"); // суррогат, а не ярлык

    const restored = await reidentifyDocx(hidden.bytes, vault, { fuzzy: true });
    expect(await textOf(restored.bytes)).toBe("Пробы отобрал Ким П.С. на участке");
  });
});
