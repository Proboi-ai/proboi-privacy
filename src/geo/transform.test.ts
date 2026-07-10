import { describe, it, expect } from "bun:test";
import { toLocalCS, fromLocalCS, datumConvert, type LocalCSKey } from "./transform";
import type { GeoPoint } from "./coords";

const KEY: LocalCSKey = { dx: 1234.5, dy: -678.9, rotation: 0.37, scale: 1.02 };
const P: GeoPoint = { lat: 55.7558, lon: 37.6173 };

describe("privacy/geo/transform: местная СК (обратимость)", () => {
  it("round-trip toLocalCS→fromLocalCS == оригинал", () => {
    const back = fromLocalCS(toLocalCS(P, KEY), KEY);
    expect(back.lat).toBeCloseTo(P.lat, 9);
    expect(back.lon).toBeCloseTo(P.lon, 9);
  });

  it("без ключа перехода (неверный ключ) координата НЕ восстанавливается", () => {
    const local = toLocalCS(P, KEY);
    const wrong: LocalCSKey = { dx: 0, dy: 0, rotation: 0, scale: 1 };
    const back = fromLocalCS(local, wrong);
    // расхождение заметно больше точности — восстановить нельзя
    expect(Math.abs(back.lat - P.lat)).toBeGreaterThan(1);
    expect(Math.abs(back.lon - P.lon)).toBeGreaterThan(1);
  });
});

describe("privacy/geo/transform: датум-конверсия proj4", () => {
  it("WGS84 ↔ Пулково-1942 round-trip в пределах точности", () => {
    const pulkovo = datumConvert(P, "WGS84", "СК-42");
    const back = datumConvert(pulkovo, "СК-42", "WGS84");
    expect(back.lat).toBeCloseTo(P.lat, 6);
    expect(back.lon).toBeCloseTo(P.lon, 6);
  });

  it("СК-42 реально сдвигает координату (не тождество)", () => {
    const pulkovo = datumConvert(P, "WGS84", "СК-42");
    expect(pulkovo.lat).not.toBeCloseTo(P.lat, 6);
  });

  it("неизвестная СК → ошибка", () => {
    expect(() => datumConvert(P, "WGS84", "МАРС-2050")).toThrow();
  });
});
