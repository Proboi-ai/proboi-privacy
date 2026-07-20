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
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { deidentifyOutbound, deidentifyToolOutput, deidentifyToolResponse, recentReceipts, __resetVaultsForTests, configurePersistentVault } from "./egress-gate";
import { sqliteVaultStore } from "./vault-store";

describe("egress-gate: deidentifyOutbound", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "egress-gate-"));
    prevStateDir = process.env.STATE_DIR;
    prevProfile = process.env.PRIVACY_PROFILE;
    process.env.STATE_DIR = tmpDir;
    __resetVaultsForTests(); // per-user vault — модуль-синглтон, тесты не должны течь друг в друга
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    if (prevProfile === undefined) delete process.env.PRIVACY_PROFILE;
    else process.env.PRIVACY_PROFILE = prevProfile;
    delete process.env.PRIVACY_ALLOW_PASSTHROUGH; // escape-hatch не течёт между тестами
    rmSync(tmpDir, { recursive: true, force: true });
    __resetVaultsForTests();
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

  test("fail-closed: профиль base без passthrough → БЛОК (throw), сырьё НЕ уходит", async () => {
    writeProfile(tmpDir, "base");
    const original = 'Иванов И.И. из ООО "Ромашка", дело №5-123';

    // незанастроенный профиль + PRIVACY_MODULE=on = отправка сырого текста заблокирована.
    // Бросок ловит вызывающую сторону и возвращает fail-closed-заглушку вместо отправки.
    await expect(deidentifyOutbound(original)).rejects.toThrow(/fail-closed|заблокирован/i);
  });

  test("профиль base + PRIVACY_ALLOW_PASSTHROUGH=1 → явный passthrough (локальная модель)", async () => {
    writeProfile(tmpDir, "base");
    process.env.PRIVACY_ALLOW_PASSTHROUGH = "1"; // оператор осознанно разрешил (не-ПДн / локальная модель)
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

describe("egress-gate: паспорт/ИНН — раньше НЕ детектились ни на одном профиле", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "egress-gate-l11-"));
    prevStateDir = process.env.STATE_DIR;
    process.env.STATE_DIR = tmpDir;
    __resetVaultsForTests();
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    rmSync(tmpDir, { recursive: true, force: true });
    __resetVaultsForTests();
  });

  test("профиль standard: ИНН и паспорт маскируются, round-trip восстанавливает оригинал", async () => {
    writeProfile(tmpDir, "standard");
    const original = "Клиент Иванов И.И., ИНН 771234567890, паспорт серия 45 07 номер 123456.";

    const result = await deidentifyOutbound(original);

    expect(result.text).not.toContain("771234567890");
    expect(result.text).not.toContain("123456");
    expect(result.text).toMatch(/\[INN_\d+\]/);
    expect(result.text).toMatch(/\[PASSPORT_\d+\]/);

    const restored = result.reidentify(result.text);
    expect(restored).toBe(original);
  });

  test("профиль strict: телефон тоже маскируется", async () => {
    writeProfile(tmpDir, "strict");
    const original = "Свяжитесь по телефону +7 916 123-45-67, ИНН 7712345678.";

    const result = await deidentifyOutbound(original);

    expect(result.text).not.toContain("+7 916 123-45-67");
    expect(result.text).not.toContain("7712345678");
    expect(result.text).toMatch(/\[PHONE_\d+\]/);
    expect(result.text).toMatch(/\[INN_\d+\]/);

    const restored = result.reidentify(result.text);
    expect(restored).toBe(original);
  });
});

describe("egress-gate: tool-result (вложение/PDF/vision) де-идентификация", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "egress-gate-toolresult-"));
    prevStateDir = process.env.STATE_DIR;
    process.env.STATE_DIR = tmpDir;
    __resetVaultsForTests();
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    rmSync(tmpDir, { recursive: true, force: true });
    __resetVaultsForTests();
  });

  test("deidentifyToolOutput маскирует PII из содержимого файла/PDF, round-trip восстанавливает", async () => {
    writeProfile(tmpDir, "legal");
    const fileContent = 'Договор с ООО "Ромашка", директор Иванов Иван Иванович, дело №5-123.';

    const result = await deidentifyToolOutput(fileContent, "user-1");

    expect(result.text).not.toContain("Ромашка");
    expect(result.text).not.toContain("Иванов");
    expect(result.receipt.component).toBe("text-deid-tool");

    const restored = result.reidentify(result.text);
    expect(restored).toBe(fileContent);
  });

  test("deidentifyToolResponse обходит произвольную структуру tool_response и трогает только строки", async () => {
    writeProfile(tmpDir, "legal");
    const toolResponse = {
      content: [{ type: "text", text: "Заказчик ООО «Ромашка», ИНН не указан." }],
      isError: false,
      meta: { retries: 2 },
    };

    const { value, entities } = await deidentifyToolResponse(toolResponse, "user-2");

    expect(entities).toBeGreaterThan(0);
    const typed = value as typeof toolResponse;
    expect(typed.content[0]!.text).not.toContain("Ромашка");
    expect(typed.isError).toBe(false); // не строка — не тронуто
    expect(typed.meta.retries).toBe(2); // число — не тронуто

    // тот же per-user vault (user-2) восстанавливает токен, намайненный внутри обхода структуры
    const anchor = await deidentifyOutbound("", "user-2");
    expect(anchor.reidentify(typed.content[0]!.text)).toContain("Ромашка");
  });

  test("userMessage и tool_result внутри ОДНОГО хода делят ОДИН vault — reidentify userMessage восстанавливает и токены из tool_result", async () => {
    writeProfile(tmpDir, "legal");
    const userId = "user-3";

    // 1) userMessage-этап хода (как в chat())
    const userMsgResult = await deidentifyOutbound("Проверь договор с Ивановым И.И.", userId);

    // 2) внутри хода модель дёргает тул (Read/PDF), результат тоже идёт через де-ид с ТЕМ ЖЕ userId
    const toolResult = await deidentifyToolOutput("В файле упомянут Петров П.П. как свидетель.", userId);
    expect(toolResult.text).toMatch(/\[PER_\d+\]/);

    // 3) ответ модели ссылается на токен, намайненный НА ЭТАПЕ ТУЛА (а не userMessage) —
    //    до фикса reidentify() из userMessage-этапа не знал бы об этом токене (разные vault).
    const tokenFromTool = toolResult.text.match(/\[PER_\d+\]/)![0];
    const modelReply = `Свидетель ${tokenFromTool} подтвердил показания.`;

    const restored = userMsgResult.reidentify(modelReply);
    expect(restored).toBe("Свидетель Петров П.П. подтвердил показания.");
  });

  test("без userId — разовый vault (обратная совместимость, поведение как раньше)", async () => {
    writeProfile(tmpDir, "legal");
    const a = await deidentifyOutbound("Иванов И.И.");
    const b = await deidentifyOutbound("Петров П.П.");
    // разные вызовы без userId — независимые vault, счётчик токенов у обоих стартует с 01
    expect(a.text).toContain("[PER_01]");
    expect(b.text).toContain("[PER_01]");
  });
});

describe("egress-gate: golden — детерминированная структура де-ид (не LLM-текст)", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "egress-gate-golden-"));
    prevStateDir = process.env.STATE_DIR;
    process.env.STATE_DIR = tmpDir;
    __resetVaultsForTests();
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    rmSync(tmpDir, { recursive: true, force: true });
    __resetVaultsForTests();
  });

  test("golden: профиль strict на фиксированном примере — деид полностью детерминирован (regex/Natasha, без сети)", async () => {
    writeProfile(tmpDir, "strict");
    const original = 'Скважина Петрова П.П. на 55.7558, 37.6173 — участок ООО "Ромашка", дело №5-123 от 12.03.2020.';

    const result = await deidentifyOutbound(original);

    // ts — Date.now(), недетерминирован, поэтому НЕ снапшотим. hashPostRedaction — sha256(text),
    // детерминирован, но производный от text (избыточен в снапшоте рядом с самим text).
    expect({
      text: result.text,
      entities: result.receipt.entities,
      lowConfidence: result.receipt.lowConfidence,
      profile: result.receipt.profile,
      component: result.receipt.component,
    }).toMatchSnapshot();

    // round-trip остаётся честным гарантом поверх снапшота структуры.
    expect(result.reidentify(result.text)).toBe(original);
  });
});

describe("egress-gate: персистентный vault", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "egress-gate-persist-"));
    prevStateDir = process.env.STATE_DIR;
    process.env.STATE_DIR = tmpDir;
    __resetVaultsForTests();
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    delete process.env.PRIVACY_VAULT_DB;
    delete process.env.PRIVACY_KEY_DIR;
    delete process.env.PRIVACY_KEK_KEYFILE;
    configurePersistentVault(null);
    __resetVaultsForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("токены ПЕРЕЖИВАЮТ рестарт: стор общий, RAM-vaults сброшены → reidentify из стора", async () => {
    writeProfile(tmpDir, "legal");
    const store = sqliteVaultStore({ db: new Database(":memory:"), key: new Uint8Array(randomBytes(32)) });

    // сессия 1: намайнили токен ФИО
    configurePersistentVault(store);
    const r1 = await deidentifyOutbound("Договор подписал Иванов И.И.", "user-1");
    expect(r1.text).toMatch(/\[PER_\d+\]/);
    const token = r1.text.match(/\[PER_\d+\]/)![0];

    // "рестарт раннера": RAM-vaults сброшены, sqlite-стор тот же
    __resetVaultsForTests();
    configurePersistentVault(store);

    // сессия 2: ответ модели ссылается на токен сессии 1 — раньше был бы осиротевшим
    const r2 = await deidentifyOutbound("", "user-1");
    expect(r2.reidentify(`Подписант ${token} согласовал.`)).toContain("Иванов И.И.");
  });

  test("guard: PRIVACY_VAULT_DB без PRIVACY_KEY_DIR/keyfile → остаёмся на in-memory (эфемерный KEK не персистим)", async () => {
    writeProfile(tmpDir, "legal");
    process.env.PRIVACY_VAULT_DB = join(tmpDir, "vault.sqlite");
    // ключевой источник НЕ задан → персист не включается

    const r1 = await deidentifyOutbound("Свидетель Петров П.П.", "user-1");
    const token = r1.text.match(/\[PER_\d+\]/)![0];

    // рестарт: без персиста токен НЕ восстановится (in-memory поведение сохранено)
    __resetVaultsForTests();
    process.env.PRIVACY_VAULT_DB = join(tmpDir, "vault.sqlite");
    const r2 = await deidentifyOutbound("", "user-1");
    expect(r2.reidentify(`Про ${token}.`)).toBe(`Про ${token}.`); // токен остался как есть — не восстановлен
  });

  test("выключено (нет env/config) → чистый in-memory, байт-в-байт", async () => {
    writeProfile(tmpDir, "legal");
    const r = await deidentifyOutbound("Директор Сидоров С.С.", "user-1");
    expect(r.text).toMatch(/\[PER_\d+\]/);
    expect(r.reidentify(r.text)).toBe("Директор Сидоров С.С."); // round-trip в рамках сессии
  });
});

function writeProfile(stateDir: string, profile: string): void {
  const dir = join(stateDir, "privacy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ profile }));
}
