/**
 * Тесты TokenVault, включая durable-режим (переживание рестарта через vault-store).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { TokenVault } from "./vault";
import { memoryVaultStore, sqliteVaultStore } from "./vault-store";

const KEK = new Uint8Array(randomBytes(32));

describe("TokenVault: in-memory (без стора — прежнее поведение)", () => {
  test("дедуп: тот же (тип, оригинал) → тот же токен; счётчик на тип", () => {
    const v = new TokenVault();
    const a = v.tokenFor("PER", "Иванов И.И.");
    const b = v.tokenFor("ORG", 'ООО "Ромашка"');
    expect(v.tokenFor("PER", "Иванов И.И.")).toBe(a); // повтор → тот же токен
    expect(a).toBe("[PER_01]");
    expect(b).toBe("[ORG_01]");
    expect(v.original(a)).toBe("Иванов И.И.");
    expect(v.size()).toBe(2);
  });
});

describe("TokenVault: durable через memoryVaultStore", () => {
  test("новый TokenVault на том же сторе+скоупе восстанавливает карту и счётчик", () => {
    const store = memoryVaultStore();
    const v1 = new TokenVault({ store, scope: "user-1" });
    v1.tokenFor("PER", "Иванов И.И.");
    v1.tokenFor("PER", "Петров П.П.");

    // "рестарт": новый экземпляр из того же стора
    const v2 = new TokenVault({ store, scope: "user-1" });
    expect(v2.original("[PER_01]")).toBe("Иванов И.И.");
    expect(v2.original("[PER_02]")).toBe("Петров П.П.");
    // дедуп после гидрации: известный оригинал → тот же токен
    expect(v2.tokenFor("PER", "Иванов И.И.")).toBe("[PER_01]");
    // счётчик продолжился, а не сбросился на 01 → нет коллизии
    expect(v2.tokenFor("PER", "Сидоров С.С.")).toBe("[PER_03]");
  });

  test("скоупы изолированы", () => {
    const store = memoryVaultStore();
    new TokenVault({ store, scope: "a" }).tokenFor("PER", "Иванов");
    const vb = new TokenVault({ store, scope: "b" });
    expect(vb.size()).toBe(0); // чужой скоуп не виден
    expect(vb.tokenFor("PER", "Петров")).toBe("[PER_01]");
  });
});

describe("TokenVault: durable через sqlite — ПЕРЕЖИВАЕТ рестарт раннера", () => {
  test("рестарт (новый Database + новый TokenVault) → диалог не теряет карту токенов", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-durable-"));
    const dbPath = join(dir, "vault.sqlite");
    try {
      // сессия 1
      const db1 = new Database(dbPath);
      const v1 = new TokenVault({ store: sqliteVaultStore({ db: db1, key: KEK }), scope: "user-1" });
      const tok = v1.tokenFor("PER", "Иванов Иван Иванович");
      expect(tok).toBe("[PER_01]");
      db1.close();

      // сессия 2 (рестарт): ответ модели ссылается на [PER_01] — раньше был бы осиротевшим,
      // теперь ре-идентификация восстанавливает оригинал из шифрованного стора.
      const db2 = new Database(dbPath);
      const v2 = new TokenVault({ store: sqliteVaultStore({ db: db2, key: KEK }), scope: "user-1" });
      expect(v2.original("[PER_01]")).toBe("Иванов Иван Иванович");
      expect(v2.tokenFor("PER", "Иванов Иван Иванович")).toBe("[PER_01]"); // дедуп цел
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
