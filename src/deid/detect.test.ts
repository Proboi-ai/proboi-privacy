import { describe, it, expect } from "bun:test";
import { detectEntities, resolveOverlaps } from "./detect";

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

  it("составная фамилия через дефис", () => {
    for (const [text, expected] of [
      ["Отчёт составил Тер-Петросян А.Б.", "Тер-Петросян А.Б."],
      ["Исполнитель: Мамед-заде И.О.", "Мамед-заде И.О."],
      ["Сухово-Кобылин В.А., начальник партии", "Сухово-Кобылин В.А."],
    ] as const) {
      expect(detectEntities(text, ["PER"]).map((x) => x.raw)).toContain(expected);
    }
  });

  it("ФИО с восточным формантом отчества", () => {
    expect(detectEntities("Начальник партии Алиев Гейдар Али оглы", ["PER"]).map((x) => x.raw))
      .toContain("Алиев Гейдар Али оглы");
    expect(detectEntities("Геолог Мамедова Лейла Ариф кызы", ["PER"]).map((x) => x.raw))
      .toContain("Мамедова Лейла Ариф кызы");
  });

  it("подпись с одним инициалом", () => {
    const e = detectEntities("Проверил Гончарук И.", ["PER"]);
    expect(e.map((x) => x.raw)).toContain("Гончарук И.");
    expect(e[0]!.confidence).toBe("medium");
  });

  it("рубрикатор с буквой человеком НЕ считается", () => {
    for (const text of [
      "Приложение А. Схема расположения",
      "Таблица Б. Результаты опробования",
      "См. рисунок В. Разрез по линии",
    ]) {
      expect(detectEntities(text, ["PER"])).toHaveLength(0);
    }
  });

  it("инициалы без замыкающей точки (ячейка таблицы)", () => {
    expect(detectEntities("В ячейке: Иванов И.С", ["PER"]).map((x) => x.raw))
      .toContain("Иванов И.С");
  });
});

describe("privacy/deid/detect: ORG / DATE / CASE", () => {
  it("организация с орг-формой и кавычками", () => {
    const e = detectEntities("Заказчик ООО «ГеоПроект» подписал акт", ["ORG"]);
    expect(e).toHaveLength(1);
    expect(e[0]!.raw).toBe("ООО «ГеоПроект»");
  });

  it("организация с конструкцией «имени» маскируется одним спаном", () => {
    const e = detectEntities("ПАО «Татнефть» им. В.Д. Шашина", ["ORG", "PER"]);
    expect(e.map(({ type, raw }) => ({ type, raw }))).toEqual([
      { type: "ORG", raw: "ПАО «Татнефть» им. В.Д. Шашина" },
    ]);
  });

  it("организация с родовым словом и почтовый адрес в верхнем регистре", () => {
    const text =
      "общества «Станкопоставка», 125993 МОСКВА, УЛ. Б. ГРУЗИНСКАЯ, 4/6, ГСП-3";
    const e = detectEntities(text, ["ORG", "ADDR"]);
    expect(e.map(({ type }) => type)).toEqual(["ORG", "ADDR"]);
  });

  it("обычный адрес с явными городом, улицей и домом", () => {
    const e = detectEntities(
      "Адрес эксп.: г. Киров, ул. Геофизиков, д. 85",
      ["ADDR"],
    );
    expect(e.map(({ raw }) => raw)).toEqual(["г. Киров, ул. Геофизиков, д. 85"]);
  });

  it("даты в разных форматах", () => {
    const e = detectEntities("с 12.03.2020 по 2020-04-01 и 5 мая 2021 г.", ["DATE"]);
    expect(e.map((x) => x.raw)).toEqual(
      expect.arrayContaining(["12.03.2020", "2020-04-01"]),
    );
    expect(e.some((x) => x.raw.includes("мая 2021"))).toBe(true);
  });

  it("№ дела арбитражного формата", () => {
    const e = detectEntities(
      "рассмотрены дела А40-12345/2020 и 40-283565/2022",
      ["CASE"],
    );
    expect(e.map((x) => x.raw)).toEqual(["А40-12345/2020", "40-283565/2022"]);
  });

  it("номера дел Верховного Суда", () => {
    const e = detectEntities(
      "дела 18-КГ26-41-К4, 5-АД26-12-К2 и АКПИ26-262",
      ["CASE"],
    );
    expect(e.map((x) => x.raw)).toEqual([
      "18-КГ26-41-К4",
      "5-АД26-12-К2",
      "АКПИ26-262",
    ]);
  });

  it("номер договора не переклассифицируется в номер дела", () => {
    const e = detectEntities(
      "по договору поручительства № К2600/11-0756КС/П050 и делу А40-66515/2014",
      ["CASE", "CONTRACT_NO"],
    );
    expect(e.map(({ type }) => type)).toEqual(["CONTRACT_NO", "CASE"]);
  });

  it("варианты дел, договоров и нотариального реестра", () => {
    const text = [
      "дело 2а-321/2025 и А7–12345/2026",
      "контракт №ПД-81/25",
      "соглашение №ЮК-92/24",
      "Контракт от 03.06.2020 № 0373100135320000019-0767715-01",
      "реестр.№ 89/321-н/89-2026-2-7",
    ].join("; ");
    expect(
      detectEntities(text, ["CASE", "CONTRACT_NO", "NOTARY_REG"]).map(({ type }) => type),
    ).toEqual([
      "CASE",
      "CASE",
      "CONTRACT_NO",
      "CONTRACT_NO",
      "CONTRACT_NO",
      "NOTARY_REG",
    ]);
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

  it("точное правило не затирается широким NER-спаном", () => {
    const text = "дело № А40-12345/2020";
    const resolved = resolveOverlaps([
      { type: "CASE", raw: "№ А40-12345/2020", index: 5, confidence: "high", source: "rule" },
      { type: "CASE", raw: text, index: 0, confidence: "high", source: "ner" },
    ]);
    expect(resolved.map(({ raw }) => raw)).toEqual(["№ А40-12345/2020"]);
  });
});

describe("privacy/deid/detect: Track D", () => {
  it("лицензия на недра: старый 5- и новый 6-значный формат", () => {
    const e = detectEntities("Лицензии МСК 12345 ТЭ и ЯКУ 123456 НР действуют", ["LICENSE_SUBSOIL"]);
    expect(e.map(({ raw }) => raw)).toEqual(["МСК 12345 ТЭ", "ЯКУ 123456 НР"]);
  });

  it("варианты обозначения скважины", () => {
    const text = "скв. Р-812/1; буровая №77-Б; СКВ.: Р-901";
    expect(detectEntities(text, ["WELL"]).map(({ raw }) => raw)).toEqual([
      "скв. Р-812/1",
      "буровая №77-Б",
      "СКВ.: Р-901",
    ]);
  });

  it("сокращённое название участка после OCR", () => {
    const e = detectEntities(
      "объект — уч. «Кварцевый-2»; объект Сев.-Лесное / объект м-е Озёрное",
      ["FIELD"],
    );
    expect(e.map(({ raw }) => raw)).toEqual([
      "уч. «Кварцевый-2»",
      "объект Сев.-Лесное",
      "объект м-е Озёрное",
    ]);
    expect(detectEntities("работы на Падовском участке", ["FIELD"]).map(({ raw }) => raw))
      .toEqual(["Падовском участке"]);
  });

  it("полностью закрывает составные названия геологических объектов", () => {
    const text = [
      "Восточно-Омскому участку",
      "Замковой части Березовского участка",
      "Северного участка Южно-Михайловского месторождения",
    ].join("; ");
    expect(detectEntities(text, ["FIELD"]).map(({ raw }) => raw)).toEqual([
      "Восточно-Омскому участку",
      "Замковой части Березовского участка",
      "Северного участка Южно-Михайловского месторождения",
    ]);
  });

  it("закрывает речные участки и склонения слова «участок»", () => {
    const text = "участку р. Путанка; участок недр «р. Елва, приток реки Лобва»";
    expect(detectEntities(text, ["FIELD"]).map(({ raw }) => raw)).toEqual([
      "р. Путанка",
      "участок недр «р. Елва, приток реки Лобва»",
    ]);
  });

  it("поддерживает современный и старый пятисекционный кадастровый формат", () => {
    const text = "50:12:0101003:1919; 77:01:0001:080:1003";
    expect(detectEntities(text, ["CADASTRE"]).map(({ raw }) => raw)).toEqual([
      "50:12:0101003:1919",
      "77:01:0001:080:1003",
    ]);
  });

  it("checksum-типы отбрасывают испорченные номера; подписанный ИНН маскируется всегда", () => {
    const text = [
      "ИНН 7707083893, ИНН 7707083894",
      "ОГРН 1027700132195, ОГРН 1027700132194",
      "ОГРНИП 304500116000157, ОГРНИП 304500116000156",
      "СНИЛС 112-233-445 95, СНИЛС 112-233-445 94",
      "карта 4111 1111 1111 1111, карта 4111 1111 1111 1112",
    ].join("; ");
    const e = detectEntities(text, ["INN", "OGRN", "OGRNIP", "SNILS", "CARD"]);
    expect(e.map(({ type }) => type)).toEqual(["INN", "INN", "OGRN", "OGRNIP", "SNILS", "CARD"]);
  });

  it("20 случайных числовых последовательностей не дают checksum-срабатываний", () => {
    const text = Array.from({ length: 20 }, (_, i) => String(1000000000 + i * 7919)).join(" ");
    expect(
      detectEntities(text, ["INN", "OGRN", "OGRNIP", "SNILS", "BIK", "ACCOUNT", "CARD"]),
    ).toEqual([]);
  });

  it("общие и отраслевые regex не пересекаются с чужими типами", () => {
    const text = [
      "email user@example.ru",
      "IP 192.168.1.10",
      "скважина №12-Б",
      "кадастр 77:01:0004012:123",
      "КПП 770501001",
      "договор №А-12/2026",
      "полис ОМС 1234567890123456",
      "МКБ-10: I21.0",
      "госномер А123ВС77",
    ].join("; ");
    const types = ["EMAIL", "IP", "WELL", "CADASTRE", "KPP", "CONTRACT_NO", "POLICY_OMS", "ICD", "PLATE"] as const;
    expect(detectEntities(text, [...types]).map(({ type }) => type)).toEqual([...types]);
  });

  it("AMOUNT детектится только при явном запросе типа", () => {
    const text = "Итого 125 000,50 руб.";
    expect(detectEntities(text, ["AMOUNT"]).map(({ raw }) => raw)).toEqual(["125 000,50 руб."]);
    expect(detectEntities(text, ["CARD"])).toEqual([]);
  });
});
