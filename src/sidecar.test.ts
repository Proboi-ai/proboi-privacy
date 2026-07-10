import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { SidecarManager } from "./sidecar";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-sidecar.ts");
const CRASH = join(import.meta.dir, "__fixtures__", "mock-sidecar-crash.ts");

describe("SidecarManager: absent/спавн", () => {
  it("пустая команда → absent", async () => {
    const sm = new SidecarManager([]);
    expect(await sm.health()).toBe("absent");
    expect(sm.status()).toBe("absent");
  });

  it("до start() при заданной команде → down", () => {
    const sm = new SidecarManager(["bun", MOCK]);
    expect(sm.status()).toBe("down");
  });
});

describe("SidecarManager: живой мок-сайдкар (JSON-newline RPC)", () => {
  let sm: SidecarManager | null = null;
  afterEach(async () => {
    await sm?.stop();
    sm = null;
  });

  it("start → healthy", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    await sm.start();
    expect(sm.status()).toBe("healthy");
  });

  it("deid RPC: params доходят, структурный result возвращается", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    await sm.start();
    const src = "Иванов Иван секретный отчёт";
    const ents = await sm.deid(src, ["PER"]);
    expect(ents).toHaveLength(1);
    expect(ents[0]!.type).toBe("PER");
    expect(ents[0]!.raw).toBe(src.slice(0, 5)); // мок вернул первые 5 символов
  });

  it("после stop() → down, новые запросы отклоняются", async () => {
    sm = new SidecarManager(["bun", MOCK]);
    await sm.start();
    await sm.stop();
    expect(sm.status()).toBe("down");
    await expect(sm.deid("текст", ["PER"])).rejects.toThrow();
  });
});

describe("SidecarManager: fail-closed при падении процесса", () => {
  it("сайдкар упал → health() = down", async () => {
    const sm = new SidecarManager(["bun", CRASH]);
    await sm.start(); // health-ответ приходит, затем процесс падает
    await new Promise((r) => setTimeout(r, 150)); // дать exited-хэндлеру отработать
    expect(await sm.health()).toBe("down");
    await sm.stop();
  });
});
