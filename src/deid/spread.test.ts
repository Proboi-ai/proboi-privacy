import { describe, expect, it } from "bun:test";
import { spreadIdentities } from "./spread";
import type { DetectedEntity } from "./detect";
import { createTextDeidComponent, detokenizeText } from "../components/text-deid";
import { TokenVault } from "../vault";

const per = (raw: string, index: number): DetectedEntity => ({
  type: "PER",
  raw,
  index,
  confidence: "medium",
  source: "rule",
});

/** Что протяжка добавила ПОМИМО самой находки, из которой она исходила. */
function spreadOf(text: string, found: string): string[] {
  const index = text.indexOf(found);
  const added = spreadIdentities(text, [per(found, index)]);
  return [...new Set(added.filter((e) => e.index >= index + found.length).map((e) => e.raw))];
}

describe("privacy/spread: протяжка личности по документу", () => {
  it("одиночное имя из шапки находится в теле документа во всех падежах", () => {
    const text =
      "В лице Гвоздева Алексея Петровича. Работы принял Алексей. Замечаний к Алексею нет.";
    expect(spreadOf(text, "Гвоздева Алексея Петровича").sort()).toEqual([
      "Алексей",
      "Алексею",
    ]);
  });

  it("голая фамилия из «Фамилия И.О.» находится в косвенном падеже", () => {
    const text = "Отчёт сдал Кузнецов С.А. Замечания направлены Кузнецову.";
    expect(spreadOf(text, "Кузнецов С.А.")).toEqual(["Кузнецову"]);
  });

  it("женский род берётся с отчества, а не с окончания имени", () => {
    const text = "В лице Петровой Ольги Сергеевны. Ольга подтвердила объём.";
    expect(spreadOf(text, "Петровой Ольги Сергеевны")).toContain("Ольга");
  });

  it("пара заглавных слов без отчества и инициалов личностью НЕ считается", () => {
    // Иначе «Общие Условия» протянулись бы по всему договору как человек.
    const text = "Общие Условия применяются. Общие требования к условиям поставки.";
    expect(spreadOf(text, "Общие Условия")).toEqual([]);
  });

  it("омоним гасится строчным написанием в том же документе", () => {
    // «Вера» — имя, но «вера» в том же тексте есть как обычное слово: не протягиваем.
    const text =
      "В лице Соколовой Веры Ивановны. Вера подтвердила. Наша вера в успех велика.";
    expect(spreadOf(text, "Соколовой Веры Ивановны")).not.toContain("Вера");
  });

  it("однофамильцы: общая фамилия не протягивается ни к кому", () => {
    const text =
      "Иванов Пётр Сергеевич и Иванов Илья Сергеевич. Иванову направлено уведомление.";
    const added = spreadIdentities(text, [
      per("Иванов Пётр Сергеевич", text.indexOf("Иванов Пётр Сергеевич")),
      per("Иванов Илья Сергеевич", text.indexOf("Иванов Илья Сергеевич")),
    ]);
    expect(added.map((e) => e.raw)).not.toContain("Иванову");
  });

  it("протянутая часть получает ЯРЛЫК РОДИТЕЛЯ — человек в документе один", async () => {
    const text = "В лице Гвоздева Алексея Петровича. Работы принял Алексей.";
    const vault = new TokenVault();
    const out = await createTextDeidComponent(vault).beforeEgress!(
      { kind: "text", text, meta: {} },
      { cfg: {}, now: () => 1, audit: () => {} } as never,
    );
    const tokens = [...out.text!.matchAll(/\[PER_\d+\]/gu)].map((m) => m[0]);
    expect(tokens.length).toBe(2);
    expect(new Set(tokens).size).toBe(1);
    expect(out.text).not.toContain("Алексей");
  });

  it("после протяжки документ возвращается ДОСЛОВНО", async () => {
    const text =
      "Исполнитель: Дроздова Ирина Олеговна. Ирина подтвердила объём, Дроздовой направлено уведомление.\n";
    const vault = new TokenVault();
    const out = await createTextDeidComponent(vault).beforeEgress!(
      { kind: "text", text, meta: {} },
      { cfg: {}, now: () => 1, audit: () => {} } as never,
    );
    expect(detokenizeText(out.text!, vault)).toBe(text);
  });
});
