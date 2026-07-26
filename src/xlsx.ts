import ExcelJS from "exceljs";
import JSZip from "jszip";
import { detokenizeText, tokenizeText } from "./components/text-deid";
import type { EntityType } from "./deid/entities";
import { entitiesForVertical, type Vertical } from "./deid/entities";
import type { HideOperator } from "./deid/operators";
import type { MorphAdapter } from "./deid/morph";
import type { TokenVault } from "./vault";

export interface XlsxResult {
  bytes: Uint8Array;
  replacements: number;
}

async function rewriteWorkbook(
  input: Uint8Array,
  rewrite: (value: string) => string,
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const data = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(data);
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (typeof cell.value === "string") {
          cell.value = rewrite(cell.value);
        } else if (
          cell.value &&
          typeof cell.value === "object" &&
          "formula" in cell.value &&
          typeof cell.value.result === "string"
        ) {
          cell.value = { ...cell.value, result: rewrite(cell.value.result) };
        }
      });
    });
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** Проверяет все XML-рёбра zip, включая hidden sheets и sharedStrings. */
export async function assertXlsxContainsNone(
  bytes: Uint8Array,
  forbidden: Iterable<string>,
): Promise<void> {
  const values = [...new Set(forbidden)].filter(Boolean);
  if (!values.length) return;
  const zip = await JSZip.loadAsync(bytes);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    const leaked = values.find((value) => xml.includes(value));
    if (leaked) throw new Error(`XLSX содержит исходное значение в ${name}`);
  }
}

export async function deidentifyXlsx(
  input: Uint8Array,
  vault: TokenVault,
  opts: {
    vertical: Vertical;
    types?: EntityType[];
    operator?: HideOperator;
    morph?: MorphAdapter;
  },
): Promise<XlsxResult> {
  const originals = new Set<string>();
  let replacements = 0;
  const types = opts.types ?? entitiesForVertical(opts.vertical);
  const bytes = await rewriteWorkbook(input, (value) => {
    const result = tokenizeText(value, vault, types, {
      operator: opts.operator,
      morph: opts.morph,
    });
    if (result.count) {
      for (const token of vault.tokens()) {
        const raw = vault.original(token);
        if (raw) originals.add(raw);
      }
      replacements += result.count;
    }
    return result.text;
  });
  await assertXlsxContainsNone(bytes, originals);
  return { bytes, replacements };
}

export async function reidentifyXlsx(
  input: Uint8Array,
  vault: TokenVault,
): Promise<Uint8Array> {
  return rewriteWorkbook(input, (value) => detokenizeText(value, vault));
}
