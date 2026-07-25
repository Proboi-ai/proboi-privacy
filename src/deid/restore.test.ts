import { describe, it, expect } from "bun:test";
import { TokenVault } from "../vault";
import { detokenizeText } from "../components/text-deid";
import { restoreText, describeOrphans } from "./restore";
import { levenshteinWithin } from "./levenshtein";

/** Сейф с предсказуемым содержимым: [PER_01]=Иванов И.И., [ORG_01]=ООО «Гранит», [DATE_01]=12.03.2020 */
function seededVault(): TokenVault {
  const v = new TokenVault();
  v.tokenFor("PER", "Иванов И.И.");
  v.tokenFor("ORG", 'ООО «Гранит»');
  v.tokenFor("DATE", "12.03.2020");
  return v;
}

const FUZZY = { fuzzy: true };

describe("privacy/restore: уровень 1 (точный) и обратная совместимость", () => {
  it("без флага fuzzy результат байт-в-байт совпадает с detokenizeText", () => {
    const v = seededVault();
    const samples = [
      "Отчёт подготовил [PER_01] по заказу [ORG_01] от [DATE_01].",
      "Ничего не подставляем: [PER_99] неизвестен.",
      "Искажённые ярлыки без флага НЕ восстанавливаются: [PER_1] [per_01] [PER-01]",
      "",
      "Текст вообще без ярлыков.",
    ];
    for (const s of samples) {
      expect(restoreText(s, v).text).toBe(detokenizeText(s, v));
    }
  });

  it("точный ярлык восстанавливается и считается на уровне exact", () => {
    const v = seededVault();
    const r = restoreText("Подписал [PER_01].", v, FUZZY);
    expect(r.text).toBe("Подписал Иванов И.И..");
    expect(r.restored).toBe(1);
    expect(r.byTier.exact).toBe(1);
    expect(r.orphans).toEqual([]);
  });

  it("несколько ярлыков разных типов в одном тексте", () => {
    const v = seededVault();
    const r = restoreText("[PER_01] из [ORG_01], дата [DATE_01].", v, FUZZY);
    expect(r.text).toBe('Иванов И.И. из ООО «Гранит», дата 12.03.2020.');
    expect(r.restored).toBe(3);
    expect(r.byTier.exact).toBe(3);
  });
});

describe("privacy/restore: таблица искажений (§7.4 — не менее 12)", () => {
  // Каждый случай — то, что реально делает модель с чужой разметкой.
  const CASES: Array<[name: string, distorted: string, tier: "loose" | "fuzzy"]> = [
    ["потеря ведущего нуля", "[PER_1]", "loose"],
    ["нижний регистр целиком", "[per_01]", "loose"],
    ["нижний регистр без нуля", "[per_1]", "loose"],
    ["смешанный регистр", "[Per_01]", "loose"],
    ["тире вместо подчёркивания", "[PER-01]", "loose"],
    ["длинное тире", "[PER–01]", "loose"],
    ["пробел вместо подчёркивания", "[PER 01]", "loose"],
    ["пробелы по краям", "[ PER_01 ]", "loose"],
    ["пробел после подчёркивания", "[PER_ 01]", "loose"],
    ["перенос строки внутри ярлыка", "[PER\n01]", "loose"],
    ["разметка внутри скобок", "[**PER_01**]", "loose"],
    ["обратные кавычки внутри скобок", "[`PER_01`]", "loose"],
    ["вообще без разделителя", "[PER01]", "loose"],
    ["лишние нули", "[PER_001]", "loose"],
    ["кириллическая Р вместо латинской P", "[РER_01]", "fuzzy"],
    ["кириллическая Е вместо латинской E", "[PЕR_01]", "fuzzy"],
  ];

  for (const [name, distorted, tier] of CASES) {
    it(`${name}: ${JSON.stringify(distorted)} → оригинал (${tier})`, () => {
      const v = seededVault();
      const r = restoreText(`Подписал ${distorted}.`, v, FUZZY);
      expect(r.text).toBe("Подписал Иванов И.И..");
      expect(r.restored).toBe(1);
      expect(r.byTier[tier]).toBe(1);
      expect(r.orphans).toEqual([]);
    });
  }

  it("markdown-обёртка СНАРУЖИ скобок не мешает (это уже уровень 1)", () => {
    const v = seededVault();
    const r = restoreText("Подписал **[PER_01]**.", v, FUZZY);
    expect(r.text).toBe("Подписал **Иванов И.И.**.");
    expect(r.byTier.exact).toBe(1);
  });
});

describe("privacy/restore: защита от подмены не того значения", () => {
  it("искажённый PER НЕ может восстановиться из записи ORG (кросс-тип)", () => {
    const v = new TokenVault();
    v.tokenFor("ORG", 'ООО «Гранит»'); // в сейфе ТОЛЬКО организация
    const r = restoreText("Подписал [PER_01].", v, FUZZY);
    expect(r.text).toBe("Подписал [PER_01].");
    expect(r.restored).toBe(0);
    expect(r.orphans).toEqual(["[PER_01]"]);
  });

  it("номер обязан совпасть точно: [PER_04] не подставит запись PER_03", () => {
    const v = new TokenVault();
    v.tokenFor("PER", "Иванов И.И."); // [PER_01]
    v.tokenFor("PER", "Петров П.П."); // [PER_02]
    v.tokenFor("PER", "Сидоров С.С."); // [PER_03]
    const r = restoreText("Подписал [PER_04].", v, FUZZY);
    expect(r.text).toBe("Подписал [PER_04].");
    expect(r.restored).toBe(0);
    expect(r.orphans).toEqual(["[PER_04]"]);
  });

  it("неоднозначное имя типа (равное расстояние до двух типов) → не восстанавливаем", () => {
    // 'PES' на расстоянии 1 и от 'PER', и от 'PET' — ничья, подставлять нельзя.
    const v = new TokenVault();
    v.tokenFor("PER", "Иванов И.И.");
    v.tokenFor("PET", "Барсик");
    const r = restoreText("Подписал [PES_01].", v, FUZZY);
    expect(r.text).toBe("Подписал [PES_01].");
    expect(r.restored).toBe(0);
    expect(r.orphans).toEqual(["[PES_01]"]);
  });

  it("тип, искажённый более чем на одну правку, не подбирается", () => {
    const v = seededVault();
    const r = restoreText("Подписал [XYZ_01].", v, FUZZY);
    expect(r.restored).toBe(0);
    expect(r.orphans).toEqual(["[XYZ_01]"]);
  });

  it("markdown-ссылка не считается осиротевшим ярлыком", () => {
    const v = seededVault();
    const r = restoreText("Смотри [документацию](https://example.org) и [тут].", v, FUZZY);
    expect(r.restored).toBe(0);
    expect(r.orphans).toEqual([]);
    expect(r.text).toBe("Смотри [документацию](https://example.org) и [тут].");
  });

  it("ярлык известного типа, которого нет в сейфе, попадает в orphans", () => {
    const v = seededVault();
    const r = restoreText("[PER_01] и [PER_07].", v, FUZZY);
    expect(r.restored).toBe(1);
    expect(r.orphans).toEqual(["[PER_07]"]);
  });
});

describe("privacy/restore: показ невосстановленного (§7.5)", () => {
  it("восстановилось всё → null", () => {
    const v = seededVault();
    expect(describeOrphans(restoreText("[PER_01]", v, FUZZY))).toBeNull();
  });

  it("строка содержит счётчик и типы, но НЕ содержит значений", () => {
    const v = seededVault();
    const r = restoreText("[PER_01] [ORG_01] [DATE_01] [PER_07] [ORG_09]", v, FUZZY);
    const msg = describeOrphans(r)!;

    expect(msg).toContain("2");
    expect(msg).toContain("из 5");
    expect(msg).toContain("ФИО");
    expect(msg).toContain("организация");

    // Главная проверка: ни одного оригинала и ни одного ярлыка в тексте предупреждения.
    expect(msg).not.toContain("Иванов");
    expect(msg).not.toContain("Гранит");
    expect(msg).not.toContain("12.03.2020");
    expect(msg).not.toContain("[");
  });

  it("согласование с числом: 1 значение / 2 значения / 5 значений", () => {
    const v = new TokenVault();
    const mk = (n: number) =>
      describeOrphans(
        restoreText(
          Array.from({ length: n }, (_, i) => `[PER_${String(i + 20).padStart(2, "0")}]`).join(" "),
          v,
          FUZZY,
        ),
      )!;
    expect(mk(1)).toContain("1 значение");
    expect(mk(2)).toContain("2 значения");
    expect(mk(5)).toContain("5 значений");
    expect(mk(11)).toContain("11 значений");
  });

  it("согласование названий типов: 1 организация / 2 организации / 5 организаций", () => {
    const v = new TokenVault();
    const mk = (n: number) =>
      describeOrphans(
        restoreText(
          Array.from({ length: n }, (_, i) => `[ORG_${String(i + 20).padStart(2, "0")}]`).join(" "),
          v,
          FUZZY,
        ),
      )!;
    expect(mk(1)).toContain("1 организация");
    expect(mk(2)).toContain("2 организации");
    expect(mk(5)).toContain("5 организаций");
  });
});

describe("privacy/restore: производительность (§7.4 — 100 КБ / 200 записей < 50 мс)", () => {
  it("укладывается в бюджет", () => {
    const v = new TokenVault();
    const tokens: string[] = [];
    for (let i = 0; i < 200; i++) tokens.push(v.tokenFor("PER", `Фамилия${i} И.О.`));

    // ~100 КБ текста с ярлыками вперемешку с обычным текстом.
    const filler = "Обычный текст отчёта без персональных данных, числа 123 и 45.6. ";
    let text = "";
    let i = 0;
    while (text.length < 100_000) {
      text += filler + tokens[i % tokens.length] + " ";
      i++;
    }

    const started = performance.now();
    const r = restoreText(text, v, FUZZY);
    const elapsed = performance.now() - started;

    expect(r.restored).toBeGreaterThan(500);
    expect(r.orphans).toEqual([]);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("privacy/levenshtein: расстояние с порогом", () => {
  it("одинаковые строки → 0", () => {
    expect(levenshteinWithin("PER", "PER", 1)).toBe(0);
  });

  it("одна замена → 1", () => {
    expect(levenshteinWithin("PES", "PER", 1)).toBe(1);
  });

  it("одна вставка и одно удаление → 1", () => {
    expect(levenshteinWithin("PERR", "PER", 1)).toBe(1);
    expect(levenshteinWithin("PE", "PER", 1)).toBe(1);
  });

  it("за порогом → null", () => {
    expect(levenshteinWithin("XYZ", "PER", 1)).toBeNull();
    expect(levenshteinWithin("PASSPORT", "PER", 1)).toBeNull();
  });

  it("разница длин больше порога → null без подсчёта матрицы", () => {
    expect(levenshteinWithin("A", "ABCDEFGH", 2)).toBeNull();
  });

  it("пустые строки", () => {
    expect(levenshteinWithin("", "", 0)).toBe(0);
    expect(levenshteinWithin("", "AB", 2)).toBe(2);
    expect(levenshteinWithin("AB", "", 1)).toBeNull();
  });

  it("симметричность", () => {
    expect(levenshteinWithin("ORG", "OGR", 2)).toBe(levenshteinWithin("OGR", "ORG", 2));
  });
});
