import { describe, expect, it } from "bun:test";
import { GEO_RECALL_NET, maskDetected, measureGeoRecall } from "./validation-geo";
import { detectEntities } from "./deid/detect";
import { entitiesForVertical } from "./deid/entities";

describe("сеть-подсказка: жадные паттерны находят реальные формы 01.08", () => {
  const hits = (type: keyof typeof GEO_RECALL_NET, text: string) =>
    GEO_RECALL_NET[type].reduce((n, re) => {
      re.lastIndex = 0;
      return n + [...text.matchAll(re)].length;
    }, 0);

  it("координаты: DMS, русские полушария, десятичная пара, СК-42", () => {
    expect(hits("COORD", "56°30' с.ш. 108°45' в.д.")).toBeGreaterThan(0);
    expect(hits("COORD", "точка 61.250000, 73.416700")).toBeGreaterThan(0);
    expect(hits("COORD", "Х=6 254 300,15 У=4 306 570,88")).toBeGreaterThan(0);
  });

  it("скважины и лицензии", () => {
    expect(hits("WELL", "скв. №4 пробурена")).toBeGreaterThan(0);
    expect(hits("WELL", "скважина 33-Р законсервирована")).toBeGreaterThan(0);
    expect(hits("LICENSE_SUBSOIL", "лицензия ЯКУ 12345 НР")).toBeGreaterThan(0);
  });

  it("названия: месторождение, участок, реки", () => {
    expect(hits("GEO_NAME", "Марковское месторождение")).toBeGreaterThan(0);
    expect(hits("GEO_NAME", "участок Восточный")).toBeGreaterThan(0);
    expect(hits("GEO_NAME", "в долине р. Лена")).toBeGreaterThan(0);
  });
});

describe("maskDetected", () => {
  it("заменяет спаны детектора токенами, не смещая соседние", () => {
    const text = "Лицензия ЯКУ 12345 НР для скв. №4.";
    const masked = maskDetected(text, detectEntities(text, entitiesForVertical("geo")));
    expect(masked).not.toContain("ЯКУ 12345");
    expect(masked).toContain("[LICENSE_SUBSOIL]");
  });
});

describe("measureGeoRecall", () => {
  it("пойманное детектором не считается пропуском; открытое — считается", () => {
    const rep = measureGeoRecall([
      { id: "a", text: "Лицензия ЯКУ 12345 НР выдана для скважины №44. Координаты 61.250000, 73.416700." },
    ]);
    expect(rep.типы.LICENSE_SUBSOIL.вИсходном).toBeGreaterThan(0);
    expect(rep.типы.LICENSE_SUBSOIL.осталосьПослеМаски).toBe(0);
    expect(rep.типы.LICENSE_SUBSOIL.полнотаPct).toBe(100);
  });

  it("тип без находок сети даёт полноту null, а не 100%", () => {
    const rep = measureGeoRecall([{ id: "b", text: "обычный текст без геологии" }]);
    expect(rep.типы.CADASTRE.вИсходном).toBe(0);
    expect(rep.типы.CADASTRE.полнотаPct).toBeNull();
  });

  it("примеры пропусков ограничены cap и несут контекст", () => {
    // строка, которую сеть ловит: «скважина» + слово; детектор без номера её не маскирует
    const text = Array.from({ length: 30 }, (_, i) => `Про скважину глубокую номер ${i} речи нет.`).join(" ");
    const rep = measureGeoRecall([{ id: "c", text }], { sampleCap: 3 });
    expect(rep.примерыПропусков.length).toBeLessThanOrEqual(3);
    for (const leak of rep.примерыПропусков) {
      expect(leak.context.length).toBeGreaterThan(0);
    }
  });
});
