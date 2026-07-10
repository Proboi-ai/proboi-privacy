import { describe, it, expect } from "bun:test";
import { detectCoords } from "./coords";

describe("privacy/geo/coords: детекция", () => {
  it("десятичные градусы, широта-долгота по умолчанию", () => {
    const c = detectCoords("Скважина на 55.7558, 37.6173 пробурена в 2019");
    expect(c).toHaveLength(1);
    expect(c[0]!.lat).toBeCloseTo(55.7558, 4);
    expect(c[0]!.lon).toBeCloseTo(37.6173, 4);
  });

  it("полушария N/E задают ось независимо от порядка", () => {
    const c = detectCoords("точка 37.6173 E, 55.7558 N");
    expect(c).toHaveLength(1);
    expect(c[0]!.lat).toBeCloseTo(55.7558, 4);
    expect(c[0]!.lon).toBeCloseTo(37.6173, 4);
  });

  it("русские полушария С/В и южное → отрицательная широта", () => {
    const c = detectCoords("43.1155 Ю, 131.8855 В");
    expect(c).toHaveLength(1);
    expect(c[0]!.lat).toBeCloseTo(-43.1155, 4);
    expect(c[0]!.lon).toBeCloseTo(131.8855, 4);
  });

  it("формат DMS с секундами", () => {
    const c = detectCoords(`координаты 55°45'21"N 37°37'02"E`);
    expect(c).toHaveLength(1);
    expect(c[0]!.lat).toBeCloseTo(55 + 45 / 60 + 21 / 3600, 4);
    expect(c[0]!.lon).toBeCloseTo(37 + 37 / 60 + 2 / 3600, 4);
  });

  it("вне диапазона (широта > 90) отбрасывается", () => {
    expect(detectCoords("значения 123.4567, 891.2345")).toHaveLength(0);
  });

  it("обычные числа без координатной формы не ловятся", () => {
    // 1-2 знака после запятой не считаем координатой (порог ≥3)
    expect(detectCoords("масса 1.5 кг, глубина 12.7 м")).toHaveLength(0);
  });

  it("несколько пар в тексте", () => {
    const c = detectCoords("от 55.7558, 37.6173 до 59.9343, 30.3351");
    expect(c).toHaveLength(2);
  });
});
