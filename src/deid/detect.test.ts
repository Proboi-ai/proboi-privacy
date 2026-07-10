import { describe, it, expect } from "bun:test";
import { detectEntities } from "./detect";

describe("privacy/deid/detect: ФИО", () => {
  it("Фамилия И.О.", () => {
    const e = detectEntities("Отчёт составил Иванов И.П. лично", ["PER"]);
    expect(e).toHaveLength(1);
    expect(e[0]!.raw).toBe("Иванов И.П.");
    expect(e[0]!.type).toBe("PER");
  });

  it("И.О. Фамилия", () => {
    const e = detectEntities("Утвердил А.С. Петров", ["PER"]);
    expect(e.map((x) => x.raw)).toContain("А.С. Петров");
  });

  it("полное ФИО с отчеством", () => {
    const e = detectEntities("Ответственный: Сидоров Пётр Иванович", ["PER"]);
    expect(e.map((x) => x.raw)).toContain("Сидоров Пётр Иванович");
  });
});

describe("privacy/deid/detect: ORG / DATE / CASE", () => {
  it("организация с орг-формой и кавычками", () => {
    const e = detectEntities("Заказчик ООО «ГеоПроект» подписал акт", ["ORG"]);
    expect(e).toHaveLength(1);
    expect(e[0]!.raw).toBe("ООО «ГеоПроект»");
  });

  it("даты в разных форматах", () => {
    const e = detectEntities("с 12.03.2020 по 2020-04-01 и 5 мая 2021 г.", ["DATE"]);
    expect(e.map((x) => x.raw)).toEqual(
      expect.arrayContaining(["12.03.2020", "2020-04-01"]),
    );
    expect(e.some((x) => x.raw.includes("мая 2021"))).toBe(true);
  });

  it("№ дела арбитражного формата", () => {
    const e = detectEntities("рассмотрено дело А40-12345/2020 судом", ["CASE"]);
    expect(e.map((x) => x.raw)).toContain("А40-12345/2020");
  });

  it("типы фильтруются — просят только DATE, ФИО не ловим", () => {
    const e = detectEntities("Иванов И.П. 12.03.2020", ["DATE"]);
    expect(e).toHaveLength(1);
    expect(e[0]!.type).toBe("DATE");
  });

  it("перекрытия сняты (нет дублей на одном спане)", () => {
    const e = detectEntities("ООО «Роснефть» и ООО «Роснефть»", ["ORG"]);
    expect(e).toHaveLength(2);
  });
});
