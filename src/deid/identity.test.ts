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

describe("privacy/deid/identity: возврат в ТОТ ЖЕ документ — дословно", () => {
  /** Сейф, который помнит вхождения по порядку — как настоящий после обезличивания. */
  const vaultWith = (occ: Array<{ cue: string; form: string }>): IdentityVault => ({
    original: (t) => (t === "[PER_01]" ? occ[0]!.form : undefined),
    entry: (t) => (t === "[PER_01]" ? { type: "PER", lemma: "Иванов И.П." } : undefined),
    useFor: () => undefined,
    occurrenceAt: (t, n) => (t === "[PER_01]" ? occ[n] : undefined),
  });

  it("две РАЗНЫЕ формы под одним ярлыком возвращаются каждая на своё место", () => {
    // До 30.07 обе подставлялись из одной таблицы «слово → форма», и вторая приезжала
    // в падеже первой: 40,2% договоров возвращались с другим окончанием, чем были.
    const vault = vaultWith([
      { cue: "", form: "Иванов И.П." },
      { cue: "", form: "Иванову И.П." },
    ]);
    const text = "[PER_01] подписал. Направлено: [PER_01].";
    expect(originalFor(vault, "[PER_01]", text, text.indexOf("["), 0)).toBe("Иванов И.П.");
    expect(originalFor(vault, "[PER_01]", text, text.lastIndexOf("["), 1)).toBe("Иванову И.П.");
  });

  it("модель переписала окружение — дословная ступень выключается, работает прежняя", () => {
    // Слово слева не то, что было при обезличивании → позиционной форме верить нельзя.
    const vault = vaultWith([{ cue: "направлено", form: "Иванову И.П." }]);
    const text = "С [PER_01] согласовано";
    expect(originalFor(vault, "[PER_01]", text, text.indexOf("["), 0)).toBe("Ивановым И.П.");
  });

  it("номер вхождения не передан — поведение ровно прежнее", () => {
    const vault = vaultWith([{ cue: "", form: "Иванову И.П." }]);
    const text = "[PER_01] подписал";
    expect(originalFor(vault, "[PER_01]", text, 0)).toBe("Иванов И.П.");
  });
});
