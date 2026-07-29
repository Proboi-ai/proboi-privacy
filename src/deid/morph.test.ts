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

describe("privacy/deid/morph: ФИО нерусского происхождения", () => {
  it("не склоняет неизменяемую приставку дефисной фамилии", () => {
    expect(morph.inflect("Тер-Петросян А.Б.", { case: "dat", gender: "masc" }, "PER")).toBe(
      "Тер-Петросяну А.Б.",
    );
  });

  it("определяет женский пол по отчеству и не склоняет фамилию на согласный", () => {
    const analysis = morph.analyze("Ким Ольга Сергеевна", "PER");
    expect(analysis?.form.gender).toBe("femn");
    expect(morph.inflect("Ким О.С.", { case: "dat", gender: "femn" }, "PER")).toBe("Ким О.С.");
  });

  it("ту же фамилию у мужчины склоняет", () => {
    expect(morph.inflect("Ким П.С.", { case: "dat", gender: "masc" }, "PER")).toBe("Киму П.С.");
  });

  it("определяет пол по восточному форманту отчества", () => {
    expect(morph.analyze("Алиев Гейдар Али оглы", "PER")?.form.gender).toBe("masc");
    expect(morph.analyze("Мамедова Лейла Ариф кызы", "PER")?.form.gender).toBe("femn");
  });

  it("даёт ОДНУ лемму на все падежи — один человек не получит два суррогата", () => {
    const nominative = morph.analyze("Оганесян А.Р.", "PER")?.lemma;
    expect(morph.analyze("Оганесяну А.Р.", "PER")?.lemma).toBe(nominative!);
    expect(morph.analyze("Оганесяном А.Р.", "PER")?.lemma).toBe(nominative!);
  });

  it("определяет падеж нерусской фамилии", () => {
    expect(morph.analyze("Кимом П.С.", "PER")?.form.case).toBe("ins");
    expect(morph.analyze("Гончаруку И.П.", "PER")?.form.case).toBe("dat");
  });

  // lvovich определяет пол по КОСВЕННОЙ форме фамилии неверно: «Ковалёвой» и «Ивановой» он
  // считает мужскими — и дальше склоняет их по мужскому образцу («к Ковалёве»).
  it("пол женской фамилии определяется и по косвенной форме", () => {
    for (const raw of ["Ковалёва М.С.", "Ковалёвой М.С.", "Ивановой А.А."]) {
      expect(morph.analyze(raw, "PER")?.form.gender).toBe("femn");
    }
  });

  it("женскую фамилию склоняет по женскому образцу", () => {
    expect(morph.inflect("Ковалёва М.С.", { case: "dat", gender: "femn" }, "PER"))
      .toBe("Ковалёвой М.С.");
  });
});
