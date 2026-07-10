import { describe, it, expect } from "bun:test";
import { createTextDeidComponent, tokenizeText, detokenizeText } from "./text-deid";
import { TokenVault } from "../vault";
import type { ComponentContext, Payload } from "../types";

function ctx(cfg: Record<string, unknown> = {}, audit: unknown[] = []): ComponentContext {
  return { cfg, now: () => 1_700_000_000_000, audit: (ev) => audit.push(ev) };
}

describe("privacy/text-deid: токенизация PII", () => {
  it("round-trip: ФИО+ORG+дата → токены → оригинал", () => {
    const vault = new TokenVault();
    const src = "Иванов И.П. (ООО «ГеоПроект») сдал отчёт 12.03.2020";
    const { text, count } = tokenizeText(src, vault);
    expect(count).toBe(3);
    expect(text).toContain("[PER_01]");
    expect(text).toContain("[ORG_01]");
    expect(text).toContain("[DATE_01]");
    expect(text).not.toContain("Иванов");
    expect(text).not.toContain("ГеоПроект");
    expect(detokenizeText(text, vault)).toBe(src);
  });

  it("дедуп: одинаковая сущность → один токен", () => {
    const vault = new TokenVault();
    const { text } = tokenizeText("ООО «Роснефть» и снова ООО «Роснефть»", vault);
    expect(text.match(/\[ORG_01\]/g)).toHaveLength(2);
    expect(text).not.toContain("[ORG_02]");
  });

  it("нумерация раздельная по типам", () => {
    const vault = new TokenVault();
    const { text } = tokenizeText("Иванов И.П. и Петров А.С. в 2020-01-01", vault);
    expect(text).toContain("[PER_01]");
    expect(text).toContain("[PER_02]");
    expect(text).toContain("[DATE_01]");
  });

  it("egress: PII не утекает, квитанция без сырья", async () => {
    const vault = new TokenVault();
    const events: unknown[] = [];
    const comp = createTextDeidComponent(vault);
    const p: Payload = { kind: "text", text: "Подпись: Сидоров Пётр Иванович", meta: {} };
    const out = await comp.beforeEgress!(p, ctx({}, events));
    expect(out.text).not.toContain("Сидоров");
    expect((events[0] as any).detail.count).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("Сидоров"); // сырьё не в аудите
    const back = await comp.afterResponse!(out, ctx());
    expect(back.text).toBe("Подпись: Сидоров Пётр Иванович");
  });

  it("cfg.entities ограничивает типы", async () => {
    const vault = new TokenVault();
    const comp = createTextDeidComponent(vault);
    const p: Payload = { kind: "text", text: "Иванов И.П. 12.03.2020", meta: {} };
    const out = await comp.beforeEgress!(p, ctx({ entities: ["DATE"] }));
    expect(out.text).toContain("Иванов И.П."); // ФИО не тронуто
    expect(out.text).toContain("[DATE_01]");
  });
});
