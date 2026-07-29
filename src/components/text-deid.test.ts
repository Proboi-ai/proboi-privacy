import { describe, it, expect } from "bun:test";
import { createTextDeidComponent, tokenizeText, detokenizeText } from "./text-deid";
import { TokenVault } from "../vault";
import { createLocalMorphAdapter } from "../deid/morph";
import { createSurrogateOperator } from "../deid/operators";
import type { ComponentContext, Payload } from "../types";

function ctx(cfg: Record<string, unknown> = {}, audit: unknown[] = []): ComponentContext {
  return { cfg, now: () => 1_700_000_000_000, audit: (ev) => audit.push(ev) };
}

describe("privacy/text-deid: токенизация PII", () => {
  it("round-trip: ФИО+ORG+дата → токены → оригинал", () => {
    const vault = new TokenVault();
    const src = "Иванов И.П. (ООО «ГеоПроект») сдал отчёт 12.03.2020";
    const { text, count } = tokenizeText(src, vault);
    expect(count).toBe(3);
    expect(text).toContain("[PER_01]");
    expect(text).toContain("[ORG_01]");
    expect(text).toContain("[DATE_01]");
    expect(text).not.toContain("Иванов");
    expect(text).not.toContain("ГеоПроект");
    expect(detokenizeText(text, vault)).toBe(src);
  });

  it("дедуп: одинаковая сущность → один токен", () => {
    const vault = new TokenVault();
    const { text } = tokenizeText("ООО «Роснефть» и снова ООО «Роснефть»", vault);
    expect(text.match(/\[ORG_01\]/g)).toHaveLength(2);
    expect(text).not.toContain("[ORG_02]");
  });

  it("нумерация раздельная по типам", () => {
    const vault = new TokenVault();
    const { text } = tokenizeText("Иванов И.П. и Петров А.С. в 2020-01-01", vault);
    expect(text).toContain("[PER_01]");
    expect(text).toContain("[PER_02]");
    expect(text).toContain("[DATE_01]");
  });

  it("egress: PII не утекает, квитанция без сырья", async () => {
    const vault = new TokenVault();
    const events: unknown[] = [];
    const comp = createTextDeidComponent(vault);
    const p: Payload = { kind: "text", text: "Подпись: Сидоров Пётр Иванович", meta: {} };
    const out = await comp.beforeEgress!(p, ctx({}, events));
    expect(out.text).not.toContain("Сидоров");
    expect((events[0] as any).detail.count).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("Сидоров"); // сырьё не в аудите
    const back = await comp.afterResponse!(out, ctx());
    expect(back.text).toBe("Подпись: Сидоров Пётр Иванович");
  });

  it("cfg.entities ограничивает типы", async () => {
    const vault = new TokenVault();
    const comp = createTextDeidComponent(vault);
    const p: Payload = { kind: "text", text: "Иванов И.П. 12.03.2020", meta: {} };
    const out = await comp.beforeEgress!(p, ctx({ entities: ["DATE"] }));
    expect(out.text).toContain("Иванов И.П."); // ФИО не тронуто
    expect(out.text).toContain("[DATE_01]");
  });

  it("cfg.vertical используется только когда явного entities нет", async () => {
    const comp = createTextDeidComponent(new TokenVault());
    const p: Payload = {
      kind: "text",
      text: "СНИЛС 112-233-445 95, карта 4111 1111 1111 1111",
      meta: {},
    };
    const medical = await comp.beforeEgress!(p, ctx({ vertical: "medical" }));
    expect(medical.text).toContain("[SNILS_01]");
    expect(medical.text).toContain("4111 1111 1111 1111");

    const explicit = await comp.beforeEgress!(p, ctx({ vertical: "medical", entities: ["CARD"] }));
    expect(explicit.text).toContain("112-233-445 95");
    expect(explicit.text).toContain("[CARD_01]");
  });

  it("surrogate сохраняет падеж, пишет безопасный audit и восстанавливает оригинал", async () => {
    const events: unknown[] = [];
    const comp = createTextDeidComponent(new TokenVault());
    const p: Payload = { kind: "text", text: "Поручено Иванову И.И.", meta: {} };
    const out = await comp.beforeEgress!(
      p,
      ctx({ entities: ["PER"], hideMode: "surrogate", morph: "local" }, events),
    );
    expect(out.text).toMatch(/^Поручено [А-ЯЁ][а-яё]+у [А-ЯЁ]\.[А-ЯЁ]\.$/u);
    expect(out.text).not.toContain("Иванов");
    expect((events[0] as any).detail).toMatchObject({
      hideMode: "surrogate",
      replacements: 1,
    });
    expect(JSON.stringify(events)).not.toContain("Иванов");
    expect((await comp.afterResponse!(out, ctx())).text).toBe(p.text);
  });

  // Сейф нумеровал ФОРМУ: «Иванов И.П.», «Иванову И.П.» и «Ивановым И.П.» давали три токена,
  // и для модели это были три разных человека.
  it("один человек в трёх падежах — один ярлык, и возврат байт-в-байт", () => {
    const v = new TokenVault();
    const src =
      "Отчёт составил Иванов И.П. Задание направлено Иванову И.П. Согласовано с Ивановым И.П.";
    const out = tokenizeText(src, v, ["PER"]);

    expect(v.size()).toBe(1);
    expect(out.text).toBe(
      "Отчёт составил [PER_01] Задание направлено [PER_01] Согласовано с [PER_01]",
    );
    expect(out.text).not.toContain("Иванов");
    expect(detokenizeText(out.text, v)).toBe(src);
  });

  it("возврат ставит падеж по месту ярлыка, а не по канону", () => {
    const v = new TokenVault();
    tokenizeText("Задание направлено Иванову И.П. Согласовано с Ивановым И.П.", v, ["PER"]);
    // слово-подсказка встречалось при обезличивании → форма точная (сама она кончается точкой)
    expect(detokenizeText("Работа направлено [PER_01]", v)).toBe("Работа направлено Иванову И.П.");
    // модель перефразировала: падеж по однозначному предлогу
    expect(detokenizeText("Вопрос к [PER_01] снят.", v)).toBe("Вопрос к Иванову И.П. снят.");
    expect(detokenizeText("Ответ от [PER_01]", v)).toBe("Ответ от Иванова И.П.");
    // подсказок нет — именительный, а не косвенный канон
    expect(detokenizeText("[PER_01] подписал акт.", v)).toBe("Иванов И.П. подписал акт.");
  });

  it("перестановка предложений моделью падежи не ломает", () => {
    const v = new TokenVault();
    tokenizeText("Составил Иванов И.П. Направлено Иванову И.П. Принято Ивановым И.П.", v, ["PER"]);
    expect(detokenizeText("Принято [PER_01] Составил [PER_01] Направлено [PER_01]", v))
      .toBe("Принято Ивановым И.П. Составил Иванов И.П. Направлено Иванову И.П.");
  });

  it("женское ФИО не склоняется по мужскому образцу", () => {
    const v = new TokenVault();
    const src = "Акт подписала Ковалёва М.С. Копия вручена Ковалёвой М.С.";
    const out = tokenizeText(src, v, ["PER"]);
    expect(v.size()).toBe(1);
    expect(detokenizeText(out.text, v)).toBe(src);
    expect(detokenizeText("Обратиться к [PER_01] лично.", v)).toBe("Обратиться к Ковалёвой М.С. лично.");
  });

  it("surrogate: один человек в разных падежах — одно вымышленное имя, падеж свой", () => {
    const v = new TokenVault();
    const morph = createLocalMorphAdapter();
    const src = "Составил Иванов И.П. Направлено Иванову И.П.";
    const out = tokenizeText(src, v, ["PER"], {
      operator: createSurrogateOperator({ morph }),
      morph,
    });
    expect(v.size()).toBe(1);
    expect(out.text).not.toContain("Иванов");
    // одна и та же вымышленная фамилия в двух падежах: именительный и дательный на -у
    const m = /^Составил ([А-ЯЁ][а-яё]+) ([А-ЯЁ]\.[А-ЯЁ]\.) Направлено \1у \2$/u.exec(out.text);
    expect(m).not.toBeNull();
    expect(detokenizeText(out.text, v)).toBe(src);
  });

  it("surrogate с выключенной морфологией отклоняется", async () => {
    const comp = createTextDeidComponent(new TokenVault());
    const p: Payload = { kind: "text", text: "Иванов И.И.", meta: {} };
    await expect(
      comp.beforeEgress!(
        p,
        ctx({ entities: ["PER"], hideMode: "surrogate", morph: "off" }),
      ),
    ).rejects.toThrow("surrogate требует работающую морфологию");
  });
});
