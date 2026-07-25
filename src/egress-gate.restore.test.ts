/**
 * Интеграция надёжного возврата (Трек C) в egress-gate.
 *
 * Отдельный файл, а не правка `egress-gate.test.ts`: спека (§14) требует, чтобы существующие
 * тесты проходили БЕЗ правок — правка существующего теста была бы сигналом, что сломали
 * совместимость.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deidentifyOutbound, recentReceipts, __resetVaultsForTests } from "./egress-gate";
import { describeOrphans } from "./deid/restore";

function writeProfile(stateDir: string, profile: string): void {
  const dir = join(stateDir, "privacy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ profile }));
}

/** Ответ «модели»: она переписала ярлыки так, как делает это в проде. */
const ORIGINAL = 'Иванов И.И. из ООО "Ромашка", дело №5-123 от 12.03.2020';

describe("egress-gate: возврат оригиналов (Трек C)", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;
  let prevProfile: string | undefined;
  let prevFuzzy: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "egress-restore-"));
    prevStateDir = process.env.STATE_DIR;
    prevProfile = process.env.PRIVACY_PROFILE;
    prevFuzzy = process.env.PRIVACY_RESTORE_FUZZY;
    process.env.STATE_DIR = tmpDir;
    __resetVaultsForTests();
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    if (prevProfile === undefined) delete process.env.PRIVACY_PROFILE;
    else process.env.PRIVACY_PROFILE = prevProfile;
    if (prevFuzzy === undefined) delete process.env.PRIVACY_RESTORE_FUZZY;
    else process.env.PRIVACY_RESTORE_FUZZY = prevFuzzy;
    rmSync(tmpDir, { recursive: true, force: true });
    __resetVaultsForTests();
  });

  test("БЕЗ флага: искажённые ярлыки НЕ восстанавливаются (поведение как раньше)", async () => {
    delete process.env.PRIVACY_RESTORE_FUZZY;
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    const mangled = result.text.replace(/\[PER_0*(\d+)\]/g, "[per-$1]");

    expect(result.reidentify(mangled)).toContain("[per-1]");
    expect(result.reidentify(mangled)).not.toContain("Иванов");
  });

  test("БЕЗ флага: обычный round-trip по-прежнему точный", async () => {
    delete process.env.PRIVACY_RESTORE_FUZZY;
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    expect(result.reidentify(result.text)).toBe(ORIGINAL);
  });

  test("БЕЗ флага: reidentify не пишет квитанцию возврата в аудит", async () => {
    delete process.env.PRIVACY_RESTORE_FUZZY;
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    const before = recentReceipts().length;
    result.reidentify(result.text);

    expect(recentReceipts().length).toBe(before);
    expect(recentReceipts()[recentReceipts().length - 1]!.component).toBe("text-deid");
  });

  test("С флагом: потерянный ноль, регистр и тире восстанавливаются", async () => {
    process.env.PRIVACY_RESTORE_FUZZY = "1";
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    const mangled = result.text.replace(/\[([A-Z]+)_0*(\d+)\]/g, (_m, t: string, n: string) =>
      `[${t.toLowerCase()}-${n}]`,
    );

    expect(result.reidentify(mangled)).toBe(ORIGINAL);
  });

  test("С флагом: markdown вокруг и внутри ярлыка не мешает", async () => {
    process.env.PRIVACY_RESTORE_FUZZY = "1";
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    const mangled = result.text.replace(/\[PER_(\d+)\]/g, "[**PER_$1**]");

    expect(result.reidentify(mangled)).toContain("Иванов И.И.");
  });

  test("С флагом: квитанция возврата несёт restored и orphans (§7.4)", async () => {
    process.env.PRIVACY_RESTORE_FUZZY = "1";
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    // Дописываем ярлык, которого в сейфе нет, — он обязан стать «сиротой».
    const reply = `${result.text} и ещё [PER_77]`;
    const report = result.reidentifyDetailed(reply);

    expect(report.orphans).toEqual(["[PER_77]"]);
    expect(report.restored).toBeGreaterThan(0);

    const last = recentReceipts()[recentReceipts().length - 1]!;
    expect(last.component).toBe("text-deid-restore");
    expect(last.orphans).toBe(1);
    expect(last.restored).toBe(report.restored);
  });

  test("квитанция возврата не содержит ни оригиналов, ни ярлыков", async () => {
    process.env.PRIVACY_RESTORE_FUZZY = "1";
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    result.reidentifyDetailed(`${result.text} и ещё [PER_77]`);

    const serialized = JSON.stringify(recentReceipts());
    expect(serialized).not.toContain("Иванов");
    expect(serialized).not.toContain("Ромашка");
    expect(serialized).not.toContain("PER_");
  });

  test("предупреждение для пользователя строится по отчёту и не раскрывает значений", async () => {
    process.env.PRIVACY_RESTORE_FUZZY = "1";
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    const report = result.reidentifyDetailed(`${result.text} и ещё [PER_77]`);
    const msg = describeOrphans(report)!;

    expect(msg).toContain("1 значение");
    expect(msg).toContain("ФИО");
    expect(msg).not.toContain("Иванов");
    expect(msg).not.toContain("[");
  });

  test("reidentifyDetailed доступен и без флага — отчёт считается, поведение не меняется", async () => {
    delete process.env.PRIVACY_RESTORE_FUZZY;
    writeProfile(tmpDir, "legal");

    const result = await deidentifyOutbound(ORIGINAL);
    const report = result.reidentifyDetailed(result.text);

    expect(report.text).toBe(ORIGINAL);
    expect(report.byTier.exact).toBe(report.restored);
    expect(report.byTier.loose).toBe(0);
    expect(report.byTier.fuzzy).toBe(0);
    expect(describeOrphans(report)).toBeNull();
  });
});
