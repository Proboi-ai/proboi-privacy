import { describe, expect, it } from "bun:test";
import { createLocalMorphAdapter, type GramCase } from "./morph";

const morph = createLocalMorphAdapter();

describe("privacy/deid/morph: local", () => {
  const cases: Array<[GramCase, string, string, string]> = [
    ["nom", "Соколов", "Соколова", "Седых А.В."],
    ["gen", "Соколова", "Соколовой", "Седых А.В."],
    ["dat", "Соколову", "Соколовой", "Седых А.В."],
    ["acc", "Соколова", "Соколову", "Седых А.В."],
    ["ins", "Соколовым", "Соколовой", "Седых А.В."],
    ["loc", "Соколове", "Соколовой", "Седых А.В."],
  ];

  for (const [gramCase, male, female, neut] of cases) {
    it(`${gramCase}: склоняет фамилии трёх родовых классов`, () => {
      expect(morph.inflect("Соколов", { case: gramCase, gender: "masc" }, "PER")).toBe(male);
      expect(morph.inflect("Соколова", { case: gramCase, gender: "femn" }, "PER")).toBe(female);
      expect(morph.inflect("Седых А.В.", { case: gramCase, gender: "neut" }, "PER")).toBe(neut);
    });
  }

  it("определяет дательный падеж и мужской род", () => {
    expect(morph.analyze("Иванову И.И.", "PER")?.form).toMatchObject({
      case: "dat",
      gender: "masc",
      number: "sing",
    });
  });

  it("согласует частое существительное с числом", () => {
    expect(morph.agreeWithNumber?.(2, "скважина")).toBe("скважины");
    expect(morph.agreeWithNumber?.(5, "скважина")).toBe("скважин");
  });

  it("склоняет составной топоним", () => {
    expect(morph.inflect("Нижний Новгород", { case: "loc" }, "ADDR")).toBe(
      "Нижнем Новгороде",
    );
  });
});
