/**
 * Юнит-тесты моста egress-gate (см. egress-gate.ts). Проверяет
 * round-trip де-ид/ре-ид по реальным примитивам (tokenizeText/detokenizeText), receipt-контракт
 * и best-effort персист аудита. Интеграцию с вызывающей стороной (хост-приложением) юнит-тестами
 * НЕ покрываем — она тяжёлая; грепгейт + full suite green достаточны как проверка.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deidentifyOutbound, recentReceipts } from "./egress-gate";

describe("egress-gate: deidentifyOutbound", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "egress-gate-"));
    prevStateDir = process.env.STATE_DIR;
    prevProfile = process.env.PRIVACY_PROFILE;
    process.env.STATE_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    if (prevProfile === undefined) delete process.env.PRIVACY_PROFILE;
    else process.env.PRIVACY_PROFILE = prevProfile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("профиль legal: ФИО/ORG/дело/дата токенизируются, round-trip восстанавливает оригинал", async () => {
    writeProfile(tmpDir, "legal");
    const original = 'Иванов И.И. из ООО "Ромашка", дело №5-123 от 12.03.2020';

    const result = await deidentifyOutbound(original);

    expect(result.text).not.toContain("Иванов");
    expect(result.text).not.toContain("Ромашка");
    expect(result.text).not.toContain("№5-123");
    expect(result.receipt.entities).toBeGreaterThan(0);
    expect(result.receipt.profile).toBe("legal");
    expect(result.receipt.hashPostRedaction).toMatch(/^[0-9a-f]{64}$/);

    const restored = result.reidentify(result.text);
    expect(restored).toBe(original);
  });

  test("профиль base: pure passthrough — текст не меняется, entities:0, квитанция всё равно пишется", async () => {
    writeProfile(tmpDir, "base");
    const original = 'Иванов И.И. из ООО "Ромашка", дело №5-123';

    const result = await deidentifyOutbound(original);

    expect(result.text).toBe(original);
    expect(result.receipt.entities).toBe(0);
    expect(result.receipt.profile).toBe("base");
    expect(result.receipt.hashPostRedaction).toMatch(/^[0-9a-f]{64}$/);
  });

  test("профиль geo: КООРДИНАТЫ маскируются (COORD via geo/coords), round-trip восстанавливает", async () => {
    writeProfile(tmpDir, "geo");
    const original = "Скважина Иванова И.И. на 55.7558, 37.6173 — участок Северный.";

    const result = await deidentifyOutbound(original);

    // главное PII гео-отчёта — координаты — не должны уйти в облако как есть
    expect(result.text).not.toContain("55.7558");
    expect(result.text).not.toContain("37.6173");
    expect(result.text).toMatch(/\[COORD_\d+\]/);
    expect(result.text).not.toContain("Иванова"); // и ФИО заодно
    expect(result.receipt.profile).toBe("geo");

    const restored = result.reidentify(result.text);
    expect(restored).toBe(original);
  });

  test("профиль standard: ФИО/ORG токенизируются, дата/дело — НЕТ (только PER/ORG)", async () => {
    writeProfile(tmpDir, "standard");
    const original = 'Договор с ООО "Ромашка", директор Иванов Иван Иванович, дело №5-123 от 12.03.2020';

    const result = await deidentifyOutbound(original);

    expect(result.text).not.toContain("Иванов");
    expect(result.text).not.toContain("Ромашка");
    // standard не включает DATE/CASE — номер дела и дата уходят как есть
    expect(result.text).toContain("№5-123");
    expect(result.text).toContain("12.03.2020");
    expect(result.receipt.entities).toBeGreaterThan(0);
    expect(result.receipt.profile).toBe("standard");

    const restored = result.reidentify(result.text);
    expect(restored).toBe(original);
  });

  test("профиль strict: ФИО/ORG/дата/дело токенизируются на русском примере, round-trip восстанавливает", async () => {
    writeProfile(tmpDir, "strict");
    const original = 'Договор с ООО "Ромашка", директор Иванов Иван Иванович';

    const result = await deidentifyOutbound(original);

    expect(result.text).not.toContain("Ромашка");
    expect(result.text).not.toContain("Иванов Иван Иванович");
    expect(result.text).toMatch(/\[ORG_\d+\]/);
    expect(result.text).toMatch(/\[PER_\d+\]/);
    expect(result.receipt.entities).toBeGreaterThan(0);
    expect(result.receipt.profile).toBe("strict");

    const restored = result.reidentify(result.text);
    expect(restored).toBe(original);
  });

  test("профиль strict: дата/номер дела/координаты тоже токенизируются (максимум из deid)", async () => {
    writeProfile(tmpDir, "strict");
    const original = "Скважина Иванова И.И. на 55.7558, 37.6173, дело №5-123 от 12.03.2020.";

    const result = await deidentifyOutbound(original);

    expect(result.text).not.toContain("Иванова");
    expect(result.text).not.toContain("55.7558");
    expect(result.text).not.toContain("№5-123");
    expect(result.text).not.toContain("12.03.2020");
    expect(result.text).toMatch(/\[PER_\d+\]/);
    expect(result.text).toMatch(/\[COORD_\d+\]/);
    expect(result.text).toMatch(/\[CASE_\d+\]/);
    expect(result.text).toMatch(/\[DATE_\d+\]/);

    const restored = result.reidentify(result.text);
    expect(restored).toBe(original);
  });

  test("без profile.json → фолбэк на PRIVACY_PROFILE env, дефолт base", async () => {
    process.env.PRIVACY_PROFILE = "geo";
    const result = await deidentifyOutbound('Иванов И.И. из ООО "Ромашка"');
    expect(result.receipt.profile).toBe("geo");
    expect(result.text).not.toContain("Иванов");
  });

  test("квитанция персистится в STATE_DIR/privacy/audit.jsonl и читается назад", async () => {
    writeProfile(tmpDir, "geo");
    await deidentifyOutbound("Петров П.П.");

    const auditPath = join(tmpDir, "privacy", "audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.component).toBe("text-deid");
    expect(typeof last.ts).toBe("number");
  });

  test("recentReceipts() возвращает записанные квитанции (in-memory ring)", async () => {
    writeProfile(tmpDir, "geo");
    await deidentifyOutbound("Сидоров С.С.");
    const receipts = recentReceipts();
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts[receipts.length - 1]!.component).toBe("text-deid");
  });
});

function writeProfile(stateDir: string, profile: string): void {
  const dir = join(stateDir, "privacy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ profile }));
}
