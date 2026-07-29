import { describe, expect, it } from "bun:test";
import {
  inferSurnameCase,
  inflectSurname,
  lemmatizeSurname,
  parseName,
  surnameForms,
} from "./surname";

describe("privacy/deid/surname: разбор ФИО", () => {
  it("находит фамилию во всех формах записи", () => {
    expect(parseName("Иванов И.И.").surname).toBe("Иванов");
    expect(parseName("И.И. Иванов").surname).toBe("Иванов");
    expect(parseName("Иванов Иван Иванович").surname).toBe("Иванов");
    expect(parseName("Тер-Петросян А.Б.").surname).toBe("Тер-Петросян");
    expect(parseName("Абдусамаов Х.А.").surname).toBe("Абдусамаов");
  });

  it("берёт пол из отчества, а не из фамилии", () => {
    // Фамилия сама по себе пола не даёт — lvovich отдаёт androgynous.
    expect(parseName("Ким Ольга Сергеевна").gender).toBe("femn");
    expect(parseName("Гончарук Пётр Иванович").gender).toBe("masc");
    expect(parseName("Оганесян Ашот Арменович").gender).toBe("masc");
    expect(parseName("Абдусамаов Хамид Абдусамаович").gender).toBe("masc");
  });

  it("берёт пол из восточного форманта отчества", () => {
    const male = parseName("Алиев Гейдар Али оглы");
    expect(male.gender).toBe("masc");
    expect(male.surname).toBe("Алиев");
    const female = parseName("Мамедова Лейла Ариф кызы");
    expect(female.gender).toBe("femn");
    expect(female.surname).toBe("Мамедова");
  });

  it("не выдумывает пол, когда признаков нет", () => {
    expect(parseName("Ким Е.А.").gender).toBeNull();
    expect(parseName("Нгуен").gender).toBeNull();
  });
});

describe("privacy/deid/surname: склонение", () => {
  it("не склоняет неизменяемую приставку дефисной фамилии", () => {
    // lvovich без этого слоя даёт «Тера-Петросяна».
    expect(inflectSurname("Тер-Петросян", "gen", "masc")).toBe("Тер-Петросяна");
    expect(inflectSurname("Тер-Петросян", "ins", "masc")).toBe("Тер-Петросяном");
  });

  it("склоняет обе части настоящей двойной фамилии", () => {
    expect(inflectSurname("Салтыков-Щедрин", "gen", "masc")).toBe("Салтыкова-Щедрина");
    expect(inflectSurname("Немирович-Данченко", "gen", "masc")).toBe("Немировича-Данченко");
  });

  it("не склоняет женскую фамилию на согласный", () => {
    for (const surname of ["Ким", "Оганесян", "Гончарук", "Нгуен", "Шмидт"]) {
      expect(inflectSurname(surname, "dat", "femn")).toBe(surname);
      expect(inflectSurname(surname, "ins", "femn")).toBe(surname);
    }
  });

  it("ту же фамилию у мужчины склоняет", () => {
    expect(inflectSurname("Ким", "dat", "masc")).toBe("Киму");
    expect(inflectSurname("Оганесян", "ins", "masc")).toBe("Оганесяном");
    expect(inflectSurname("Гончарук", "gen", "masc")).toBe("Гончарука");
  });

  it("оставляет несклоняемые классы как есть", () => {
    for (const surname of ["Шевченко", "Даниленко", "Черных", "Долгих", "Живаго", "Гулиа", "Ли"]) {
      expect(inflectSurname(surname, "gen", "masc")).toBe(surname);
    }
  });

  it("сохраняет русскую норму без регресса", () => {
    expect(inflectSurname("Иванов", "ins", "masc")).toBe("Ивановым");
    expect(inflectSurname("Петрова", "dat", "femn")).toBe("Петровой");
    expect(inflectSurname("Кафка", "gen", "masc")).toBe("Кафки");
  });
});

describe("privacy/deid/surname: лемма и падеж", () => {
  it("приводит косвенную форму к именительному", () => {
    expect(lemmatizeSurname("Иванову", "masc")).toBe("Иванов");
    expect(lemmatizeSurname("Ивановым", "masc")).toBe("Иванов");
    expect(lemmatizeSurname("Кимом", "masc")).toBe("Ким");
    expect(lemmatizeSurname("Оганесяну", "masc")).toBe("Оганесян");
    expect(lemmatizeSurname("Тер-Петросяна", "masc")).toBe("Тер-Петросян");
  });

  it("не трогает именительный, похожий на косвенный", () => {
    for (const surname of ["Гулиа", "Данелия", "Ким", "Шевченко", "Черных", "Ли"]) {
      expect(lemmatizeSurname(surname, "masc")).toBe(surname);
    }
  });

  it("форму на -а после согласной трактует как косвенную — задокументированный компромисс", () => {
    // «Гончарука» (родительный) и «Глоба» (именительный) неразличимы без контекста.
    // Выбор в пользу леммы: иначе один человек получит два разных суррогата в документе.
    expect(lemmatizeSurname("Гончарука", "masc")).toBe("Гончарук");
    expect(lemmatizeSurname("Глоба", "masc")).toBe("Глоб");
  });

  it("определяет падеж, включая нерусские фамилии", () => {
    expect(inferSurnameCase("Кимом", "masc")).toBe("ins");
    expect(inferSurnameCase("Оганесяну", "masc")).toBe("dat");
    expect(inferSurnameCase("Иванову", "masc")).toBe("dat");
    expect(inferSurnameCase("Ким", "masc")).toBe("nom");
    expect(inferSurnameCase("Шевченко", "masc")).toBe("nom");
  });

  it("строит все шесть форм", () => {
    const forms = surnameForms("Гончарук", "masc");
    expect(forms.get("nom")).toBe("Гончарук");
    expect(forms.get("gen")).toBe("Гончарука");
    expect(forms.get("ins")).toBe("Гончаруком");
    expect(new Set(surnameForms("Шевченко", "masc").values()).size).toBe(1);
  });
});
