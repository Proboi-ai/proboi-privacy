/**
 * Юнит-тесты шифрованного бэкенда Token Vault (vault-store.ts).
 * Проверяем: round-trip, что на диске ТОЛЬКО шифртекст, AAD-привязку (нельзя переставить блоб
 * на чужой токен/скоуп), провал на чужом KEK, и переживание "рестарта" (новый Database на том же файле).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  sealValue,
  openValue,
  memoryVaultStore,
  sqliteVaultStore,
  type VaultStore,
} from "./vault-store";

const KEK = new Uint8Array(randomBytes(32));

describe("vault-store: примитивы seal/open", () => {
  test("round-trip восстанавливает оригинал", () => {
    const blob = sealValue(KEK, "user-1", "[PER_01]", "Иванов Иван Иванович");
    expect(openValue(KEK, "user-1", "[PER_01]", blob)).toBe("Иванов Иван Иванович");
  });

  test("на диске ТОЛЬКО шифртекст — оригинала в блобе нет", () => {
    const secret = "Скважина Петрова на участке Северный";
    const blob = sealValue(KEK, "u", "[PER_01]", secret);
    expect(Buffer.from(blob).toString("utf8")).not.toContain("Петров");
    expect(Buffer.from(blob).toString("latin1")).not.toContain("Северный");
    expect(blob[0]).toBe(1); // версия формата
  });

  test("чужой KEK → расшифровка падает (GCM-тег)", () => {
    const blob = sealValue(KEK, "u", "[PER_01]", "секрет");
    const otherKek = new Uint8Array(randomBytes(32));
    expect(() => openValue(otherKek, "u", "[PER_01]", blob)).toThrow();
  });

  test("AAD-привязка: блоб нельзя открыть под чужим token или scope", () => {
    const blob = sealValue(KEK, "user-1", "[PER_01]", "секрет");
    // тот же KEK, но другой token → подключ и AAD другие → провал
    expect(() => openValue(KEK, "user-1", "[PER_02]", blob)).toThrow();
    // тот же KEK/token, но другой scope → провал
    expect(() => openValue(KEK, "user-2", "[PER_01]", blob)).toThrow();
  });

  test("порча шифртекста → провал (аутентификация)", () => {
    const blob = sealValue(KEK, "u", "[PER_01]", "секрет");
    blob[blob.length - 1] ^= 0xff; // портим GCM-тег
    expect(() => openValue(KEK, "u", "[PER_01]", blob)).toThrow();
  });
});

describe("vault-store: memoryVaultStore (дефолт/тесты)", () => {
  test("put/load по скоупу", () => {
    const s: VaultStore = memoryVaultStore();
    s.put("a", { token: "[PER_01]", type: "PER", raw: "Иванов" });
    s.put("b", { token: "[PER_01]", type: "PER", raw: "Петров" });
    expect(s.load("a")).toEqual([{ token: "[PER_01]", type: "PER", raw: "Иванов" }]);
    expect(s.load("b")).toEqual([{ token: "[PER_01]", type: "PER", raw: "Петров" }]);
    expect(s.load("c")).toEqual([]);
  });
});

describe("vault-store: sqliteVaultStore", () => {
  test("KEK не 32 байта → ошибка на старте", () => {
    expect(() => sqliteVaultStore({ db: new Database(":memory:"), key: new Uint8Array(16) })).toThrow(/32 байта/);
  });

  test("round-trip через sqlite; в колонке blob нет оригинала", () => {
    const db = new Database(":memory:");
    const store = sqliteVaultStore({ db, key: KEK });
    store.put("user-1", { token: "[ORG_01]", type: "ORG", raw: 'ООО "Ромашка"' });
    expect(store.load("user-1")).toEqual([{ token: "[ORG_01]", type: "ORG", raw: 'ООО "Ромашка"' }]);
    // в сырой колонке blob — только шифртекст
    const rows = db.query("SELECT blob FROM vault").all() as Array<{ blob: Uint8Array }>;
    expect(rows.length).toBe(1);
    expect(Buffer.from(rows[0]!.blob).toString("utf8")).not.toContain("Ромашка");
  });

  test("персист переживает РЕСТАРТ (новый Database на том же файле → карта цела)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-store-"));
    const dbPath = join(dir, "vault.sqlite");
    try {
      // сессия 1: пишем
      const db1 = new Database(dbPath);
      const s1 = sqliteVaultStore({ db: db1, key: KEK });
      s1.put("user-1", { token: "[PER_01]", type: "PER", raw: "Иванов И.И." });
      s1.put("user-1", { token: "[PER_02]", type: "PER", raw: "Петров П.П." });
      db1.close();

      // сессия 2 ("рестарт раннера"): новый хэндл, тот же KEK → карта восстановлена
      const db2 = new Database(dbPath);
      const s2 = sqliteVaultStore({ db: db2, key: KEK });
      const loaded = s2.load("user-1").sort((a, b) => a.token.localeCompare(b.token));
      expect(loaded).toEqual([
        { token: "[PER_01]", type: "PER", raw: "Иванов И.И." },
        { token: "[PER_02]", type: "PER", raw: "Петров П.П." },
      ]);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("после рестарта ЧУЖОЙ KEK не расшифровывает (диск бесполезен без ключа)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-store-"));
    const dbPath = join(dir, "vault.sqlite");
    try {
      const db1 = new Database(dbPath);
      sqliteVaultStore({ db: db1, key: KEK }).put("u", { token: "[PER_01]", type: "PER", raw: "секрет" });
      db1.close();

      const db2 = new Database(dbPath);
      const wrong = sqliteVaultStore({ db: db2, key: new Uint8Array(randomBytes(32)) });
      expect(() => wrong.load("u")).toThrow();
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
