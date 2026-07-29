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

  test("ключ личности сводит падежи одного человека в ОДИН токен", () => {
    const v = new TokenVault();
    const a = v.tokenFor("PER", "Иванов И.П.", "Иванов И.П.");
    const b = v.tokenFor("PER", "Иванову И.П.", "Иванов И.П.");
    const c = v.tokenFor("PER", "Ивановым И.П.", "Иванов И.П.");
    expect([b, c]).toEqual([a, a]);
    expect(v.size()).toBe(1);
    // канон — форма первого вхождения; остальные доступны через подсказки
    expect(v.original(a)).toBe("Иванов И.П.");
  });

  test("без ключа личности поведение прежнее: форма = отдельный токен", () => {
    const v = new TokenVault();
    expect(v.tokenFor("PER", "Иванов И.П.")).toBe("[PER_01]");
    expect(v.tokenFor("PER", "Иванову И.П.")).toBe("[PER_02]");
  });

  test("подсказки: первое наблюдение выигрывает, чужое слово ничего не даёт", () => {
    const v = new TokenVault();
    const t = v.tokenFor("PER", "Иванов И.П.", "Иванов И.П.");
    v.recordUse(t, "направлено", "Иванову И.П.");
    v.recordUse(t, "направлено", "Ивановская И.П."); // повтор не перезаписывает
    v.recordUse(t, "", "мимо"); // пустая подсказка не пишется
    expect(v.useFor(t, "направлено")).toBe("Иванову И.П.");
    expect(v.useFor(t, "с")).toBeUndefined();
  });

  test("originals() отдаёт ВСЕ написания — иначе fail-closed проверка пропустит падежи", () => {
    const v = new TokenVault();
    const t = v.tokenFor("PER", "Иванов И.П.", "Иванов И.П.");
    v.setSurface(t, { lemma: "Иванов И.П." });
    v.recordUse(t, "направлено", "Иванову И.П.");
    v.recordUse(t, "с", "Ивановым И.П.");
    expect(new Set(v.originals())).toEqual(
      new Set(["Иванов И.П.", "Иванову И.П.", "Ивановым И.П."]),
    );
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

  test("метаданные суррогата переживают рестарт", () => {
    const store = memoryVaultStore();
    const v1 = new TokenVault({ store, scope: "user-1" });
    const token = v1.tokenFor("PER", "Иванов И.И.");
    v1.setSurface(token, {
      surface: "Смирнов А.А.",
      lemma: "Иванов И.И.",
      morph: { case: "nom", gender: "masc" },
    });

    const v2 = new TokenVault({ store, scope: "user-1" });
    expect(v2.entry(token)).toMatchObject({
      raw: "Иванов И.И.",
      surface: "Смирнов А.А.",
      morph: { case: "nom", gender: "masc" },
    });
  });

  test("личность и подсказки переживают рестарт: дедуп по лемме, форма по слову", () => {
    const store = memoryVaultStore();
    const v1 = new TokenVault({ store, scope: "user-1" });
    const token = v1.tokenFor("PER", "Иванов И.П.", "Иванов И.П.");
    v1.recordUse(token, "направлено", "Иванову И.П.");

    const v2 = new TokenVault({ store, scope: "user-1" });
    expect(v2.useFor(token, "направлено")).toBe("Иванову И.П.");
    // после гидрации ключом остаётся ЛИЧНОСТЬ, а не сырая строка: иначе новая падежная
    // форма того же человека завела бы второй токен
    expect(v2.tokenFor("PER", "Ивановым И.П.", "Иванов И.П.")).toBe(token);
    expect(v2.size()).toBe(1);
  });

  test("записи, сделанные до появления ключа личности, читаются как раньше", () => {
    const store = memoryVaultStore();
    // строка старой схемы: identity/uses отсутствуют
    store.put("user-1", { token: "[PER_01]", type: "PER", raw: "Иванов И.И." });

    const v = new TokenVault({ store, scope: "user-1" });
    expect(v.original("[PER_01]")).toBe("Иванов И.И.");
    expect(v.tokenFor("PER", "Иванов И.И.")).toBe("[PER_01]"); // дедуп по сырой строке цел
    expect(v.useFor("[PER_01]", "направлено")).toBeUndefined();
    // и запись можно дополнить на месте, без миграции
    v.recordUse("[PER_01]", "направлено", "Иванову И.И.");
    expect(new TokenVault({ store, scope: "user-1" }).useFor("[PER_01]", "направлено"))
      .toBe("Иванову И.И.");
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
