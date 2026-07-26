import { describe, expect, it } from "bun:test";
import { ENTITY_REGISTRY, entitiesForVertical } from "./entities";

describe("privacy/deid/entities", () => {
  it("реестр не содержит дублей", () => {
    const types = ENTITY_REGISTRY.map(({ type }) => type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("finance включает common и финансовые типы, но AMOUNT остаётся opt-in", () => {
    const types = entitiesForVertical("finance");
    expect(types).toContain("PER");
    expect(types).toContain("ACCOUNT");
    expect(types).toContain("CARD");
    expect(types).not.toContain("AMOUNT");
    expect(types).not.toContain("SNILS");
  });

  it("SNILS включён только для medical/hr", () => {
    expect(entitiesForVertical("medical")).toContain("SNILS");
    expect(entitiesForVertical("hr")).toContain("SNILS");
    expect(entitiesForVertical("legal")).not.toContain("SNILS");
  });

  it("кадастровый номер защищается и в геологических, и в юридических документах", () => {
    expect(entitiesForVertical("geo")).toContain("CADASTRE");
    expect(entitiesForVertical("legal")).toContain("CADASTRE");
  });

  it("номер договора защищается и в геологических, и в юридических документах", () => {
    expect(entitiesForVertical("geo")).toContain("CONTRACT_NO");
    expect(entitiesForVertical("legal")).toContain("CONTRACT_NO");
  });
});
