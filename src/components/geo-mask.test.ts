import { describe, it, expect } from "bun:test";
import { createGeoMaskComponent, tokenizeCoords, detokenizeCoords } from "./geo-mask";
import { GeoVault } from "../geo/vault";
import type { ComponentContext, Payload } from "../types";

function ctx(audit: unknown[] = []): ComponentContext {
  return {
    cfg: {},
    now: () => 1_700_000_000_000,
    audit: (ev) => audit.push(ev),
  };
}

describe("privacy/geo-mask: токенизация координат", () => {
  it("round-trip: координата → токен → координата == оригинал", () => {
    const vault = new GeoVault();
    const src = "Устье скважины 55.7558, 37.6173 в пределах лицензии.";
    const { text, count } = tokenizeCoords(src, vault);
    expect(count).toBe(1);
    expect(text).toContain("[GEO_01]");
    expect(text).not.toContain("55.7558");
    expect(detokenizeCoords(text, vault)).toBe(src);
  });

  it("одинаковая координата → один и тот же токен (дедуп)", () => {
    const vault = new GeoVault();
    const { text } = tokenizeCoords("A 55.7558, 37.6173 и B 55.7558, 37.6173", vault);
    expect(text.match(/\[GEO_01\]/g)).toHaveLength(2);
    expect(text).not.toContain("[GEO_02]");
    expect(vault.size()).toBe(1);
  });

  it("egress: наружу уходит токен, оригинал остаётся в vault на клиенте", async () => {
    const vault = new GeoVault();
    const events: unknown[] = [];
    const comp = createGeoMaskComponent(vault);
    const p: Payload = { kind: "text", text: "точка 59.9343, 30.3351", meta: {} };
    const out = await comp.beforeEgress!(p, ctx(events));
    expect(out.text).toBe("точка [GEO_01]");
    expect(out.text).not.toContain("59.9343"); // координата НЕ утекла
    // квитанция — только счётчик, без самих координат
    expect(events).toHaveLength(1);
    expect((events[0] as any).detail).toEqual({ count: 1 });
    // ре-идентификация локально
    const back = await comp.afterResponse!(out, ctx());
    expect(back.text).toBe("точка 59.9343, 30.3351");
  });

  it("текст без координат проходит без изменений и без квитанции", async () => {
    const vault = new GeoVault();
    const events: unknown[] = [];
    const comp = createGeoMaskComponent(vault);
    const p: Payload = { kind: "text", text: "обычный отчёт без координат", meta: {} };
    const out = await comp.beforeEgress!(p, ctx(events));
    expect(out.text).toBe("обычный отчёт без координат");
    expect(events).toHaveLength(0);
  });
});
