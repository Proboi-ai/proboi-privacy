import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { createTextDeidComponent } from "./text-deid";
import { TokenVault } from "../vault";
import { SidecarManager } from "../sidecar";
import type { ComponentContext, Payload } from "../types";

const MOCK = join(import.meta.dir, "..", "__fixtures__", "mock-sidecar.ts");
const ctx = (audit: unknown[] = [], cfg: Record<string, unknown> = {}): ComponentContext => ({
  cfg,
  now: () => 1_700_000_000_000,
  audit: (ev) => audit.push(ev),
});

describe("privacy/text-deid: upgrade сайдкаром (опциональный upgrade)", () => {
  let sm: SidecarManager | null = null;
  afterEach(async () => {
    await sm?.stop();
    sm = null;
  });

  it("сайдкар healthy → его сущности мержатся, квитанция sidecar:true", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    await sm.start();
    const vault = new TokenVault();
    const events: unknown[] = [];
    const comp = createTextDeidComponent(vault, { sidecar: sm });
    // «СЕКРЕ» (первые 5) — мок вернёт как PER; TS-дефолт тут PII не видит
    const p: Payload = { kind: "text", text: "СЕКРЕТ отчёт", meta: {} };
    const out = await comp.beforeEgress!(p, ctx(events));
    expect(out.text).toContain("[PER_01]");
    expect(out.text).not.toContain("СЕКРЕ");
    expect((events[0] as any).detail.sidecar).toBe(true);
  });

  it("сайдкар down → фолбэк на TS-дефолт (sidecar:false), TS PII всё равно ловится", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    // НЕ стартуем → status 'down'
    const vault = new TokenVault();
    const events: unknown[] = [];
    const comp = createTextDeidComponent(vault, { sidecar: sm });
    const p: Payload = { kind: "text", text: "Иванов И.П. сдал отчёт", meta: {} };
    const out = await comp.beforeEgress!(p, ctx(events));
    expect(out.text).toContain("[PER_01]"); // TS-дефолт поймал ФИО
    expect((events[0] as any).detail.sidecar).toBe(false);
  });

  it("GLiNER берёт отраслевой тип из vertical config", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    await sm.start();
    const comp = createTextDeidComponent(new TokenVault(), { sidecar: sm });
    const p: Payload = { kind: "text", text: "участок Тайга", meta: {} };
    const out = await comp.beforeEgress!(
      p,
      ctx([], { nerEngine: "gliner", vertical: "geo", entities: ["FIELD"] }),
    );
    expect(out.text).toBe("участок [FIELD_01]");
  });

  it("GEO-гибрид: NER закрывает название, правила — лицензию и скважину", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    await sm.start();
    const comp = createTextDeidComponent(new TokenVault(), { sidecar: sm });
    const p: Payload = {
      kind: "text",
      text: "Лицензия ЯКУ 14917 НР; скважина №Р-812; участок Тайга",
      meta: {},
    };
    const out = await comp.beforeEgress!(
      p,
      ctx([], { nerEngine: "gliner", vertical: "geo" }),
    );
    expect(out.text).toContain("[LICENSE_SUBSOIL_01]");
    expect(out.text).toContain("[WELL_01]");
    expect(out.text).toContain("[FIELD_01]");
    expect(out.text).not.toMatch(/ЯКУ|Р-812|Тайга/u);
  });

  it("падение GLiNER запускает fallback, но fail-closed блокирует egress", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    await sm.start();
    const comp = createTextDeidComponent(new TokenVault(), { sidecar: sm });
    const p: Payload = { kind: "text", text: "GLINER_FAIL Иванов И.И.", meta: {} };
    await expect(comp.beforeEgress!(
      p,
      ctx([], { nerEngine: "gliner", entities: ["PER"] }),
    )).rejects.toThrow("egress заблокирован");
  });

  it("настроенная GLiNER при down-сайдкаре блокирует сырой текст", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    const comp = createTextDeidComponent(new TokenVault(), { sidecar: sm });
    const p: Payload = { kind: "text", text: "неизвестный участок", meta: {} };
    await expect(comp.beforeEgress!(
      p,
      ctx([], { nerEngine: "gliner", vertical: "geo" }),
    )).rejects.toThrow("передача заблокирована");
  });
});
