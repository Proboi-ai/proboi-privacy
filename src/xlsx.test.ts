import { describe, expect, it } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { TokenVault } from "./vault";
import { deidentifyXlsx, reidentifyXlsx } from "./xlsx";

async function fixture(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Видимый").getCell("A1").value = "Иванов И.И.";
  const hidden = workbook.addWorksheet("Скрытый", { state: "hidden" });
  hidden.getCell("A1").value = "ООО «Ромашка»";
  hidden.getCell("A2").value = "обычное число 12345";
  const zip = await JSZip.loadAsync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  // Имитация stale pivot-cache: значение не видно в ячейках, но лежит внутри zip.
  zip.file(
    "xl/pivotCache/pivotCacheRecords1.xml",
    '<?xml version="1.0" encoding="UTF-8"?><pivotCacheRecords><s v="Иванов И.И."/></pivotCacheRecords>',
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("xlsx de-identification", () => {
  it("обрабатывает видимые и скрытые листы и восстанавливает workbook", async () => {
    const vault = new TokenVault();
    const result = await deidentifyXlsx(await fixture(), vault, {
      vertical: "legal",
      types: ["PER", "ORG"],
    });
    expect(result.replacements).toBe(2);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength,
    ) as ArrayBuffer);
    expect(workbook.getWorksheet("Видимый")!.getCell("A1").value).toBe("[PER_01]");
    expect(workbook.getWorksheet("Скрытый")!.getCell("A1").value).toBe("[ORG_01]");
    expect(workbook.getWorksheet("Скрытый")!.state).toBe("hidden");

    const restored = new ExcelJS.Workbook();
    const restoredBytes = await reidentifyXlsx(result.bytes, vault);
    await restored.xlsx.load(restoredBytes.buffer.slice(
      restoredBytes.byteOffset,
      restoredBytes.byteOffset + restoredBytes.byteLength,
    ) as ArrayBuffer);
    expect(restored.getWorksheet("Видимый")!.getCell("A1").value).toBe("Иванов И.И.");
    expect(restored.getWorksheet("Скрытый")!.getCell("A1").value).toBe("ООО «Ромашка»");
  });

  it("сырой XML не содержит оригиналы, включая sharedStrings и stale pivot cache", async () => {
    const result = await deidentifyXlsx(await fixture(), new TokenVault(), {
      vertical: "legal",
      types: ["PER", "ORG"],
    });
    const zip = await JSZip.loadAsync(result.bytes);
    const xml = (
      await Promise.all(
        Object.values(zip.files)
          .filter((entry) => !entry.dir && entry.name.endsWith(".xml"))
          .map((entry) => entry.async("string")),
      )
    ).join("\n");
    expect(xml).not.toContain("Иванов");
    expect(xml).not.toContain("Ромашка");
  });
});

describe("xlsx: ФИО в таблице, каким оно там лежит", () => {
  // Ячейка — самый частый и самый бедный контекст: рядом нет фразы, по которой можно
  // опознать человека, зато написание бывает любым. Проверяем, что и капс, и разрядка,
  // и след OCR закрываются, а `originals()` отдаёт ВСЕ падежные написания —
  // иначе fail-closed проверка книги пропустила бы косвенную форму.
  it("капс, разрядка и OCR в ячейках маскируются и возвращаются", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Исполнители");
    sheet.getCell("A1").value = "КОВАЛЁВ Д.А.";
    sheet.getCell("A2").value = "К о в а л ё в  Д. А.";
    sheet.getCell("A3").value = "Koвaлёв Д.А.";
    sheet.getCell("B1").value = "геолог";
    const input = new Uint8Array(await workbook.xlsx.writeBuffer());

    const vault = new TokenVault();
    const { bytes, replacements } = await deidentifyXlsx(input, vault, {
      vertical: "legal",
      types: ["PER"],
    });
    expect(replacements).toBe(3);

    const back = await reidentifyXlsx(bytes, vault);
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(back as unknown as ArrayBuffer);
    const cells = restored.getWorksheet("Исполнители")!;
    expect(cells.getCell("A1").value).toBe("КОВАЛЁВ Д.А.");
    expect(cells.getCell("A2").value).toBe("К о в а л ё в  Д. А.");
    expect(cells.getCell("A3").value).toBe("Koвaлёв Д.А.");
    expect(cells.getCell("B1").value).toBe("геолог");
  });
});
