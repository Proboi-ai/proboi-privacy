/**
 * Личность и её употребления: один ярлык на человека, но форма при возврате — по месту.
 */
import { describe, it, expect } from "bun:test";
import { caseFromCue, cueBefore, NO_CUE, originalFor, type IdentityVault } from "./identity";

describe("privacy/deid/identity: слово-подсказка", () => {
  it("берёт слово слева от позиции", () => {
    const text = "Задание направлено [PER_01] сегодня";
    expect(cueBefore(text, text.indexOf("["))).toBe("направлено");
  });

  it("знак препинания рвёт управление — подсказки нет", () => {
    for (const text of ["Ответственный: [PER_01]", "Список — [PER_01]", "[PER_01] подписал"]) {
      expect(cueBefore(text, text.indexOf("["))).toBe(NO_CUE);
    }
  });

  it("падеж по однозначному предлогу, иначе именительный", () => {
    expect(caseFromCue("с")).toBe("ins");
    expect(caseFromCue("к")).toBe("dat");
    expect(caseFromCue("от")).toBe("gen");
    expect(caseFromCue("о")).toBe("loc");
    // Многопадежные предлоги и любые глаголы падеж не задают: без синтаксиса их не развести,
    // а ошибка падежа портит текст сильнее, чем именительный по умолчанию.
    expect(caseFromCue("в")).toBe("nom");
    expect(caseFromCue("по")).toBe("nom");
    expect(caseFromCue("подписал")).toBe("nom");
  });
});

describe("privacy/deid/identity: выбор формы оригинала", () => {
  const vault = (over: Partial<Record<string, unknown>> = {}): IdentityVault => ({
    original: () => "Иванов И.П.",
    entry: () => ({ type: "PER", lemma: "Иванов И.П.", morph: { gender: "masc" } }),
    useFor: (_t, cue) => (cue === "направлено" ? "Иванову И.П." : undefined),
    ...over,
  });

  it("наблюдённая форма важнее любых догадок", () => {
    const text = "Задание направлено [PER_01].";
    expect(originalFor(vault(), "[PER_01]", text, text.indexOf("["))).toBe("Иванову И.П.");
  });

  it("незнакомый контекст — падеж по предлогу", () => {
    for (const [text, expected] of [
      ["Вопрос к [PER_01] снят", "Иванову И.П."],
      ["Работали с [PER_01] вместе", "Ивановым И.П."],
      ["Ответ от [PER_01] получен", "Иванова И.П."],
    ] as const) {
      expect(originalFor(vault(), "[PER_01]", text, text.indexOf("["))).toBe(expected);
    }
  });

  it("подсказок нет — именительный", () => {
    const text = "[PER_01] подписал акт";
    expect(originalFor(vault(), "[PER_01]", text, 0)).toBe("Иванов И.П.");
  });

  it("не ФИО не склоняется никогда", () => {
    const org: IdentityVault = {
      original: () => 'ООО «Гранит»',
      entry: () => ({ type: "ORG" }),
    };
    const text = "Ответ от [ORG_01] получен";
    expect(originalFor(org, "[ORG_01]", text, text.indexOf("["))).toBe('ООО «Гранит»');
  });

  it("без морфологии в записи форма остаётся исходной — склонять не от чего", () => {
    const bare: IdentityVault = {
      original: () => "Иванову И.П.",
      entry: () => ({ type: "PER" }),
    };
    const text = "Ответ от [PER_01] получен";
    expect(originalFor(bare, "[PER_01]", text, text.indexOf("["))).toBe("Иванову И.П.");
  });

  it("неизвестный токен — undefined, подстановки не происходит", () => {
    const empty: IdentityVault = { original: () => undefined };
    expect(originalFor(empty, "[PER_99]", "текст [PER_99]", 6)).toBeUndefined();
  });
});
