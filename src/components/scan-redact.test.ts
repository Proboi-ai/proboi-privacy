import { describe, expect, it } from "bun:test";
import { ComponentRegistry } from "../registry";
import { EgressPipeline } from "../pipeline";
import { PrivacyBlockedError } from "../types";
import type { Payload } from "../types";
import { createScanRedactComponent, isScanPayload } from "./scan-redact";

const text = (t: string): Payload => ({ kind: "text", text: t, meta: {} });
const scanBytes = (kind = "file"): Payload => ({ kind, bytes: new Uint8Array([1, 2, 3]), meta: {} });

function pipelineWith(): { pipe: EgressPipeline; audits: string[] } {
  const reg = new ComponentRegistry();
  reg.register(createScanRedactComponent());
  reg.setEnabled("scan-redact", true);
  const audits: string[] = [];
  const pipe = new EgressPipeline(reg, {
    audit: (ev) => audits.push(`${ev.component}:${ev.action}`),
  });
  return { pipe, audits };
}

describe("scan-redact: fail-closed заслон для сканов", () => {
  it("текстовый payload проходит без изменений", async () => {
    const { pipe } = pipelineWith();
    const p = text("Иванов И.И., скважина №4");
    expect(await pipe.runEgress(p)).toEqual(p);
  });

  it("байты БЕЗ текстового слоя — блок (скан наружу не уходит)", async () => {
    const { pipe, audits } = pipelineWith();
    await expect(pipe.runEgress(scanBytes())).rejects.toThrow(PrivacyBlockedError);
    expect(audits).toContain("scan-redact:block");
  });

  it("байты с ПУСТЫМ текстовым слоем — тоже блок (пустая строка не считается слоем)", async () => {
    const { pipe } = pipelineWith();
    const p: Payload = { kind: "file", bytes: new Uint8Array([9]), text: "  \n", meta: {} };
    await expect(pipe.runEgress(p)).rejects.toThrow(PrivacyBlockedError);
  });

  it("kind='image' блокируется даже при наличии текста: подпись не чистит картинку", async () => {
    const { pipe } = pipelineWith();
    const p: Payload = { kind: "image", text: "подпись к карте", bytes: new Uint8Array([1]), meta: {} };
    await expect(pipe.runEgress(p)).rejects.toThrow(PrivacyBlockedError);
  });

  it("байты С текстовым слоем проходят: текст чистит text-deid выше по конвейеру", async () => {
    const { pipe } = pipelineWith();
    const p: Payload = { kind: "docx", bytes: new Uint8Array([1]), text: "извлечённый текст", meta: {} };
    expect(await pipe.runEgress(p)).toEqual(p);
  });

  it("выключенный компонент ничего не блокирует", async () => {
    const reg = new ComponentRegistry();
    reg.register(createScanRedactComponent());
    const pipe = new EgressPipeline(reg);
    const p = scanBytes();
    expect(await pipe.runEgress(p)).toEqual(p);
  });

  it("isScanPayload: классификация напрямую", () => {
    expect(isScanPayload(text("а"))).toBe(false);
    expect(isScanPayload(scanBytes())).toBe(true);
    expect(isScanPayload({ kind: "scan", meta: {} })).toBe(true);
    expect(isScanPayload({ kind: "pdf-scan", meta: {} })).toBe(true);
  });
});
