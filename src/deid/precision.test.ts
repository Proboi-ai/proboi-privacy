import { describe, expect, it } from "bun:test";
import { filterNerPersons, isFalsePositivePerson, refinePersons } from "./precision";
import type { DetectedEntity } from "./detect";

const drop = (raw: string, text = `Некий текст ${raw} и дальше по документу.`): boolean =>
  isFalsePositivePerson(raw, text, text.indexOf(raw));

describe("privacy/deid/precision: фильтр ложных срабатываний PER", () => {
  it("договорная номенклатура отбрасывается во всех падежах", () => {
    for (const junk of ["Заказчик", "Поставщику", "Стороны", "Товара", "Работ", "Услуги"]) {
      expect(drop(junk)).toBe(true);
    }
  });

  it("номенклатура отбрасывается ДАЖЕ в подписном блоке", () => {
    // Без этой оговорки фильтр не снимал бы ничего: «Заказчик» стоит ровно там же, где человек.
    const text = "Заказчик:\n_________ / Заказчик /\nМ.П.";
    expect(isFalsePositivePerson("Заказчик", text, text.lastIndexOf("Заказчик"))).toBe(true);
  });

  it("русские фамилии и отчества остаются — включая косвенные падежи", () => {
    for (const name of [
      "Иванов", "Иванову", "Ивановой", "Петровский", "Петровского",
      "Гончарук", "Кириленко", "Оганесян", "Мамедов", "Сергеевичу", "Сергеевны",
    ]) {
      expect(drop(name)).toBe(false);
    }
  });

  it("фамилия без русского суффикса спасается договорной подсказкой", () => {
    const text = "Договор заключён в лице директора Ким, действующего на основании устава.";
    expect(isFalsePositivePerson("Ким", text, text.indexOf("Ким"))).toBe(false);
    // Та же фамилия посреди текста без подсказки — отбрасывается. Это осознанная цена:
    // фамилию без опознаваемого суффикса и без контекста от заголовка не отличить.
    expect(drop("Ким")).toBe(true);
  });

  it("находки ПРАВИЛ не трогаются — фильтр только для NER-слоя", () => {
    const text = "Заказчик передаёт Товар";
    const ents: DetectedEntity[] = [
      { type: "PER", raw: "Заказчик", index: 0, confidence: "medium", source: "rule" },
      { type: "PER", raw: "Товар", index: text.indexOf("Товар"), confidence: "medium", source: "ner" },
      { type: "ORG", raw: "Товар", index: text.indexOf("Товар"), confidence: "medium", source: "ner" },
    ];
    const kept = filterNerPersons(text, ents);
    expect(kept.map((e) => `${e.type}:${e.raw}`)).toEqual(["PER:Заказчик", "ORG:Товар"]);
  });
});

describe("privacy/deid/precision: мусорные спаны NER", () => {
  const ner = (raw: string, index: number): DetectedEntity => ({
    type: "ORG", raw, index, confidence: "medium", source: "ner",
  });

  it("спан из одних пробелов отбрасывается", () => {
    const text = "Отчёт      подписан";
    expect(filterNerPersons(text, [ner("     ", 6)])).toEqual([]);
  });

  it("спан через разрыв колонок таблицы отбрасывается", () => {
    // Значение, пересекающее вёрстку, — это склейка двух ячеек, а не одна сущность.
    const text = "Владелец      Должность";
    expect(filterNerPersons(text, [ner("Владелец      Должность", 0)])).toEqual([]);
  });

  it("края обрезаются, координаты остаются верными", () => {
    const text = "в лице  Ромашка  далее";
    const [kept] = filterNerPersons(text, [ner("  Ромашка  ", 6)]);
    expect(kept!.raw).toBe("Ромашка");
    expect(text.slice(kept!.index, kept!.index + kept!.raw.length)).toBe("Ромашка");
  });
});

// Решения арбитра от 31.07 (см. training/expanded/VERIFIER-STAGE1-2026-07-31.md).
describe("privacy/deid/precision: решения арбитра о мемориальных именах и роли", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER",
    raw,
    index,
    confidence: "high",
    source: "rule",
  });

  it("мемориальное имя в названии учреждения не скрывается", () => {
    for (const [text, raw] of [
      ['ГБУЗ "Городская больница имени Кузнецова", именуемое Заказчик', "Кузнецова"],
      ["ФГБОУ ВО СЗГМУ им. А.Б. Кузнецова", "А.Б. Кузнецова"],
      ['музей им.В.Г. Кузнецовой", в лице', "В.Г. Кузнецовой"],
      ["школа №2 имени Сидорова Петра Ивановича станицы Крыловской", "Сидорова Петра Ивановича"],
    ] as const) {
      expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
    }
  });

  it("«от имени» — это доверенность, там человек субъект данных и остаётся скрытым", () => {
    const text = "действующий от имени Кузнецова А.Б. по доверенности";
    const raw = "Кузнецова А.Б.";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toHaveLength(1);
  });

  it("роль перед инициалами срезается, инициалы остаются скрытыми", () => {
    const text = "Ответственный за приёмку Заказчика А.Б. согласовал";
    const [kept] = refinePersons(text, [per("Заказчика А.Б.", text.indexOf("Заказчика А.Б."))]);
    expect(kept!.raw).toBe("А.Б.");
    expect(text.slice(kept!.index, kept!.index + kept!.raw.length)).toBe("А.Б.");
  });

  it("фамилия с основой из списка номенклатуры НЕ срезается", () => {
    // «Директоров», «Главных» — настоящие фамилии; суффикс сильнее стоп-листа.
    for (const raw of ["Директоров А.Б.", "Главных В.Г."]) {
      const text = `Отчёт составил ${raw} лично`;
      expect(refinePersons(text, [per(raw, text.indexOf(raw))])[0]!.raw).toBe(raw);
    }
  });

  it("находка из одной номенклатуры отбрасывается целиком", () => {
    const text = "Поставщика уведомили заранее";
    expect(refinePersons(text, [per("Поставщика", 0)])).toEqual([]);
  });
});

describe("privacy/deid/precision: остаток мемориальных и шаблоны бланка", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER", raw, index, confidence: "high", source: "rule",
  });

  it("вторая часть мемориального имени тоже не скрывается", () => {
    // Детектор разрезал «имени Кузнецова Ивана Петровича» на две находки; первая уходит по
    // подсказке вплотную, вторая — только если смотреть сквозь уже пройденные части имени.
    const text = "школа №2 имени Кузнецова Ивана Петровича станицы Крыловской";
    for (const raw of ["Кузнецова", "Ивана Петровича", "Кузнецова Ивана Петровича"]) {
      expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
    }
  });

  it("«имени» из соседнего предложения живого человека не отменяет", () => {
    const text = "Действует от имени общества. Договор подписал Кузнецов Иван Петрович лично";
    const raw = "Кузнецов Иван Петрович";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toHaveLength(1);
  });

  it("шаблон бланка не прячется", () => {
    for (const raw of ["И.О. Фамилия", "Фамилия И.О.", "Ф.И.О.", "фамилия"]) {
      const text = `Руководитель ________________ ${raw}`;
      expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
    }
  });
});

describe("privacy/deid/precision: граница мемориального прохода", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER", raw, index, confidence: "high", source: "rule",
  });

  it("капс не съедает подсказку", () => {
    const text = "МУНИЦИПАЛЬНАЯ ШКОЛА № 2 ИМЕНИ КУЗНЕЦОВА ИВАНА ПЕТРОВИЧА СТАНИЦЫ КРЫЛОВСКОЙ";
    const raw = "ИВАНА ПЕТРОВИЧА СТАНИЦЫ";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
  });

  it("перевод строки обрывает проход — подписант за названием остаётся скрытым", () => {
    const text = 'ГБУЗ "Больница имени Кузнецова"\nГлавный врач Сидоров И.И.';
    const raw = "Сидоров И.И.";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toHaveLength(1);
  });
});

describe("privacy/deid/precision: улица, названная в честь человека", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER", raw, index, confidence: "high", source: "rule",
  });

  it("тип улицы внутри находки — это адрес", () => {
    const text = "Юридический адрес: 117437, Город Москва, Улица Академика Кузнецова, Дом 17";
    const raw = "Улица Академика Кузнецова";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
  });

  it("между типом улицы и номером дома — тоже адрес", () => {
    const text = "г. Чебоксары, ул. Космонавта А.Г. Кузнецова, д. 29б, оф.201";
    const raw = "А.Г. Кузнецова";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
  });

  it("имя без адресной рамки остаётся скрытым", () => {
    // Одной подсказки мало: правило требует И тип улицы слева, И номер дома справа.
    const text = "Договор подписал ул Кузнецов Иван Петрович, действующий по уставу";
    const raw = "Кузнецов Иван Петрович";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toHaveLength(1);
  });

  it("мемориальное имя со званием не скрывается", () => {
    for (const [text, raw] of [
      ['ГБУЗ «ГКБ № 31 им. академика Кузнецовой» ДЗМ', "Кузнецовой"],
      ["Научный центр хирургии имени академика Б. В. Кузнецова», именуемое", "Б. В. Кузнецова"],
      ["школа имени Героя России Кузнецова Ивана", "Кузнецова Ивана"],
    ] as const) {
      expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
    }
  });
});

describe("privacy/deid/precision: документная согласованность мемориального имени", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER", raw, index, confidence: "high", source: "rule",
  });

  it("то же имя в другом месте документа тоже не скрывается", () => {
    const text =
      'Научный центр хирургии имени академика Б. В. Кузнецова закупает для нужд ФГБНУ «РНЦХ им. акад. Б.В. Кузнецова» партию';
    const ents = [
      per("Б. В. Кузнецова", text.indexOf("Б. В. Кузнецова")),
      per("Б.В. Кузнецова", text.indexOf("Б.В. Кузнецова")),
    ];
    expect(refinePersons(text, ents)).toEqual([]);
  });

  it("однофамилец, подписавший тот же документ, остаётся скрытым", () => {
    const text =
      'ГБУЗ «Больница имени академика Кузнецова», в лице главного врача Кузнецова И.И., действующего по уставу';
    const ents = [
      per("Кузнецова", text.indexOf("имени академика Кузнецова") + "имени академика ".length),
      per("Кузнецова И.И.", text.indexOf("Кузнецова И.И.")),
    ];
    // Мемориальное упоминание всё равно не прячется, а подписант — прячется: правило
    // документной согласованности отключено, дальше работают проверки по вхождению.
    expect(refinePersons(text, ents).map((e) => e.raw)).toEqual(["Кузнецова И.И."]);
  });
});

describe("privacy/deid/precision: сокращённое звание", () => {
  it("«им. акад. Х» тоже мемориальное", () => {
    const text = 'закупка для нужд ФГБНУ «РНЦХ им. акад. Б.В. Кузнецова» партии реагентов';
    const raw = "Б.В. Кузнецова";
    expect(
      refinePersons(text, [
        { type: "PER", raw, index: text.indexOf(raw), confidence: "high", source: "rule" },
      ]),
    ).toEqual([]);
  });
});

// Решение арбитра, вопрос 4 (31.07): автора учебника не маскируем — но только в контексте.
describe("privacy/deid/precision: автор в библиографической ссылке", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER", raw, index, confidence: "high", source: "rule",
  });

  it("автор рядом с признаками библиографии не скрывается", () => {
    for (const [text, raw] of [
      ["Приложение 1. Литература. 8 класс. Учебник. Ромашкина В. Я. и др.", "Ромашкина В. Я."],
      ["Английский язык. 4 класс, Кузнецова Н.И., Дули Д., Просвещение 2026", "Дули Д."],
      ["Биология под ред. Ромашкина В.В., ФГОС", "Ромашкина В.В."],
    ] as const) {
      expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toEqual([]);
    }
  });

  it("без библиографического контекста имя остаётся скрытым", () => {
    const text = "Товар принял Ромашкин В. Я. по накладной";
    const raw = "Ромашкин В. Я.";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toHaveLength(1);
  });

  it("подписант в договоре на учебники остаётся скрытым", () => {
    // Подписная подсказка вплотную отменяет правило целиком.
    const text = "Поставка учебников для 8 класса, в лице директора Кузнецовой И.И., действующей";
    const raw = "Кузнецовой И.И.";
    expect(refinePersons(text, [per(raw, text.indexOf(raw))])).toHaveLength(1);
  });
});

// Признак по документу (02.08). Восемь ошибок из тринадцати, подтверждённых владельцем, —
// авторы учебников в договорах с разорванной вёрсткой: подсказка и фамилия перемешаны, окном
// не достать. Замер порога на 400 договорах — в комментарии к `isBibliographicDocument`.
describe("privacy/deid/precision: документ целиком — поставка учебников", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER", raw, index, confidence: "high", source: "rule",
  });
  const one = (text: string, raw: string): DetectedEntity[] =>
    refinePersons(text, [per(raw, text.indexOf(raw))]);

  /**
   * Договор про учебники: слово встречается больше порога, а от находки оно отодвинуто
   * ЗАВЕДОМО дальше окна прежнего правила (200 знаков). Разделитель здесь не украшение:
   * без него подсказка попадала бы в окно, старое правило срабатывало само, и тест
   * проверял бы не признак документа, а то, что и так работало.
   */
  const FAR = ` ${"строка договора о поставке товара, ".repeat(9)} `;
  const textbookDoc = (row: string): string =>
    `${"Поставка учебников по контракту. ".repeat(10)}${FAR}\n${row}`;

  it("автор в товарной строке не скрывается, даже когда подсказка далеко", () => {
    // Ни «учебник», ни «класс» рядом со строкой нет — спасает только признак документа.
    const text = textbookDoc("12 06-0009-22 1.1.1.1.2 Литературное Ромашкина Л.Ф., Российская 2026 2 шт");
    expect(one(text, "Ромашкина Л.Ф.")).toEqual([]);
  });

  it("«руководитель авторского коллектива» — выходные данные книги, а не подписант", () => {
    // Слова из соседних колонок стоят вперемешку, «руководитель» падает перед фамилией автора.
    const text = textbookDoc(
      "Ромашкин                    авторского коллектива),\n            (руководитель        Васильков Ю.А., авторского Никонов В.А.",
    );
    expect(one(text, "Васильков Ю.А.")).toEqual([]);
  });

  it("настоящий подписант остаётся скрытым, даже если должность с хвостом", () => {
    // «Директор по операционной поддержке продаж ____ Фамилия» — вето требует должность
    // вплотную и на этой строке молчит; держит фамилию широкая подсказка в 120 знаках слева.
    const text = textbookDoc("Директор по операционной поддержке продаж ______________ О.В. Ромашкина м.п.");
    expect(one(text, "О.В. Ромашкина")).toHaveLength(1);
  });

  it("одинокое «руководитель» без слова «авторск» остаётся подсказкой", () => {
    const text = textbookDoc("Со стороны заказчика: руководитель Ромашкин П.С.");
    expect(one(text, "Ромашкин П.С.")).toHaveLength(1);
  });

  it("одного упоминания учебника мало — признак не поднимается", () => {
    const text = `Поставка учебников по контракту.${FAR}\nТовар принял Ромашкин В. Я. по накладной`;
    expect(one(text, "Ромашкин В. Я.")).toHaveLength(1);
  });

  it("и двух упоминаний мало: порог по документу — десять", () => {
    const text = `Поставка учебников и хозтоваров. Учебник в комплекте.${FAR}\nПринял Ромашкин В. Я., кладовщик`;
    expect(one(text, "Ромашкин В. Я.")).toHaveLength(1);
  });

  it("«авторского коллектива» открывает признак и при одном учебнике", () => {
    const text = `Поставка учебников силами авторского коллектива.${FAR}\n12 06-0009 Литературное Ромашкина Л.Ф., 2026 2 шт`;
    expect(one(text, "Ромашкина Л.Ф.")).toEqual([]);
  });
});

// Пять мелких дефектов из тех же тринадцати ошибок владельца (замер 02.08).
describe("privacy/deid/precision: мелкие дефекты разметки владельца 02.08", () => {
  const per = (raw: string, index: number): DetectedEntity => ({
    type: "PER", raw, index, confidence: "high", source: "rule",
  });
  const one = (text: string, raw: string): DetectedEntity[] =>
    refinePersons(text, [per(raw, text.indexOf(raw))]);

  it("звание с родом войск не обрывает проход к «имени»", () => {
    const text = "институт гражданской авиации имени Главного маршала авиации Б.П. Ромашкина, именуемое";
    expect(one(text, "Б.П. Ромашкина")).toEqual([]);
  });

  it("живого человека звание не отменяет: «имени» рядом нет", () => {
    const text = "в лице маршала авиации Б.П. Ромашкина, действующего на основании устава";
    expect(one(text, "Б.П. Ромашкина")).toHaveLength(1);
  });

  it("дефис в шапке бланка её не спасает", () => {
    expect(one("(наименование Поставщика-юрлица/Ф.И.О. Поставщика-физлица)", "Ф.И.О. Поставщика-физлица")).toEqual([]);
  });

  it("«Г.» в названии учреждения — город, а не инициал", () => {
    const text = "УЧРЕЖДЕНИЕ ЗДРАВООХРАНЕНИЯ ''РАЙОННАЯ БОЛЬНИЦА Г. ВЕРХНЕУРАЛЬСК, именуемое";
    expect(one(text, "БОЛЬНИЦА Г.")).toEqual([]);
  });

  it("место печати из соседней колонки — не инициалы", () => {
    const text = "Название Банка: ОКЦ № 1 ГУ Банка М.П.(при наличии) России по ЦФО";
    expect(one(text, "Банка М.П.")).toEqual([]);
  });

  it("а «Заказчика Е.В.» по-прежнему теряет только роль", () => {
    // Два инициала — это персональные данные, находка обязана выжить с обрезанной ролью.
    const text = "передано от Заказчика Е.В. по акту";
    expect(one(text, "Заказчика Е.В.")).toEqual([
      expect.objectContaining({ raw: "Е.В." }),
    ]);
  });

  it("первая часть составного слова — не фамилия", () => {
    expect(one("|Наполнение: Сэндвич-панели, | | |", "Сэндвич")).toEqual([]);
  });

  it("двойная фамилия составным словом не считается", () => {
    const text = "в лице директора Ромашкина-Ключевского А.А., действующего";
    expect(one(text, "Ромашкина")).toHaveLength(1);
  });
});
