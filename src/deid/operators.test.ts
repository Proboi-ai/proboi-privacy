import { describe, expect, it } from "bun:test";
import { TokenVault } from "../vault";
import { memoryVaultStore } from "../vault-store";
import { tokenizeText } from "../components/text-deid";
import { isValidInn, isValidOgrn, isValidSnils } from "./checksums";
import { createLocalMorphAdapter } from "./morph";
import {
  createPlaceholderOperator,
  createSurrogateOperator,
  type FakerLike,
} from "./operators";

const SEED_KEY = new Uint8Array(32).fill(7);

describe("privacy/deid/operators", () => {
  it("placeholder сохраняет прежний результат байт-в-байт", () => {
    const vault = new TokenVault();
    expect(
      tokenizeText("Иванов И.И.", vault, ["PER"], {
        operator: createPlaceholderOperator(),
      }).text,
    ).toBe("[PER_01]");
  });

  it("один tenant даёт стабильный суррогат, разные tenant — разные", () => {
    const render = (scope: string) =>
      tokenizeText(
        "Иванов И.И.",
        new TokenVault({ scope, seedKey: SEED_KEY }),
        ["PER"],
        {
          operator: createSurrogateOperator({ morph: createLocalMorphAdapter() }),
          morph: createLocalMorphAdapter(),
        },
      ).text;

    expect(render("tenant-a")).toBe(render("tenant-a"));
    expect(render("tenant-a")).not.toBe(render("tenant-b"));
  });

  it("суррогат переживает рестарт durable vault", () => {
    const store = memoryVaultStore();
    const first = new TokenVault({ store, scope: "tenant-a", seedKey: SEED_KEY });
    const text = tokenizeText("Иванов И.И.", first, ["PER"], {
      operator: createSurrogateOperator({ morph: createLocalMorphAdapter() }),
      morph: createLocalMorphAdapter(),
    }).text;

    const restarted = new TokenVault({ store, scope: "tenant-a", seedKey: SEED_KEY });
    expect(restarted.surfaces()[0]?.surface).toBe(text);
    expect(restarted.original("[PER_01]")).toBe("Иванов И.И.");
  });

  it("генерирует валидные контрольные цифры", () => {
    const vault = new TokenVault({ scope: "tenant-a", seedKey: SEED_KEY });
    const text = tokenizeText(
      "ИНН 7707083893, ОГРН 1027700132195, СНИЛС 112-233-445 95",
      vault,
      ["INN", "OGRN", "SNILS"],
      { operator: createSurrogateOperator() },
    ).text;
    const [inn, ogrn, snils] = text.match(/\d+/g) ?? [];
    expect(isValidInn(inn ?? "")).toBe(true);
    expect(isValidOgrn(ogrn ?? "")).toBe(true);
    expect(isValidSnils(snils ?? "")).toBe(true);
  });

  it("сдвигает все даты scope на одинаковую дельту", () => {
    const vault = new TokenVault({ scope: "tenant-a", seedKey: SEED_KEY });
    const text = tokenizeText("01.01.2020—11.01.2020", vault, ["DATE"], {
      operator: createSurrogateOperator(),
    }).text;
    const dates = text.match(/\d{2}\.\d{2}\.\d{4}/g) ?? [];
    expect(dates).toHaveLength(2);
    const [a, b] = dates.map((value) => {
      const [d, m, y] = value.split(".").map(Number);
      return Date.UTC(y!, m! - 1, d!);
    });
    expect((b! - a!) / 86_400_000).toBe(10);
  });

  it("координата остаётся в том же градусном квадрате и валидном диапазоне", () => {
    const vault = new TokenVault({ scope: "tenant-a", seedKey: SEED_KEY });
    const text = tokenizeText("61.2500, 73.4167", vault, ["COORD"], {
      operator: createSurrogateOperator(),
    }).text;
    expect(text).not.toBe("61.2500, 73.4167");
    const values = text.match(/[+-]?\d{1,3}\.\d{4}/g)!.map(Number);
    expect(values.map(Math.trunc)).toEqual([61, 73]);
    expect(Math.abs(values[0]!)).toBeLessThanOrEqual(90);
    expect(Math.abs(values[1]!)).toBeLessThanOrEqual(180);
  });

  it("при коллизии делает повторную попытку", () => {
    let seed = 0;
    const faker: FakerLike = {
      seed(value) {
        seed = value;
      },
      person: {
        lastName: () => (seed % 2 === 0 ? "Иванов" : "Смирнов"),
        firstName: () => "Иван",
        middleName: () => "Иванович",
      },
      company: { name: () => "Ромашка" },
      internet: { email: () => "a@example.test" },
      location: { streetAddress: () => "Новая улица, 1" },
    };
    const operator = createSurrogateOperator({ faker });
    expect(
      operator.render("PER", "[PER_01]", "Петров П.П.", {
        seed: 2,
        scopeSeed: 1,
        taken: new Set(),
        sourceText: "Иванов И.И. уже встречается",
      }),
    ).toBe("Смирнов И.И.");
  });

  // У faker 250 русских фамилий, и «Иванов» среди них: примерно раз на двести суррогат
  // совпадал с настоящей фамилией, и «обезличенный» текст по-прежнему её содержал.
  it("вымышленная фамилия не совпадает с настоящей", () => {
    let seed = 0;
    const faker: FakerLike = {
      seed(value) {
        seed = value;
      },
      // первая попытка отдаёт ровно ту фамилию, что стоит в тексте
      person: {
        lastName: () => (seed === 5 ? "Иванов" : "Смирнов"),
        firstName: () => "Пётр",
        middleName: () => "Петрович",
      },
      company: { name: () => "Ромашка" },
      internet: { email: () => "a@example.test" },
      location: { streetAddress: () => "Новая улица, 1" },
    };
    const surface = createSurrogateOperator({ faker }).render("PER", "[PER_01]", "Иванову И.И.", {
      seed: 5,
      scopeSeed: 1,
      taken: new Set(),
      sourceText: "Поручено Иванову И.И.",
    });
    expect(surface).toBe("Смирнов П.П.");
  });
});
