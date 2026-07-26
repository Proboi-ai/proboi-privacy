import { describe, expect, it } from "bun:test";
import { assertReleaseThresholds, linkageRisk, metrics, quasiRisk, scoreCorpus, type GoldDocument } from "./validation";
import { detectEntities } from "./deid/detect";

describe("validation scorer", () => {
  it("считает precision/recall/F1/F2", () => {
    expect(metrics({ tp: 8, fp: 2, fn: 2 })).toMatchObject({
      precision: 0.8,
      recall: 0.8,
      f1: 0.8000000000000002,
      f2: 0.8,
    });
  });

  it("точно сравнивает gold и детектор", () => {
    const text = "Иванов И.И.";
    const docs: GoldDocument[] = [{
      id: "one",
      vertical: "hr",
      text,
      spans: [{ type: "PER", start: 0, end: text.length }],
      quasi: ["геолог", "Москва"],
    }];
    const report = scoreCorpus(docs, (doc) => detectEntities(doc.text, ["PER"]));
    expect(report.byVertical.hr!.entity).toMatchObject({ tp: 1, fp: 0, fn: 0, recall: 1 });
    expect(report.byVertical.hr!.sensitiveCoverage).toMatchObject({ tp: 1, fp: 0, fn: 0, recall: 1 });
    expect(report.roundTrip.accuracy).toBe(1);
  });

  it("sensitive_coverage допускает только внешнюю пунктуацию и широкий span", () => {
    const text = "для скважины №A-12.";
    const start = text.indexOf("скважины");
    const docs: GoldDocument[] = [{
      id: "wide-span",
      vertical: "geo",
      text,
      spans: [{ type: "WELL", start, end: text.length }],
      quasi: [],
    }];
    const report = scoreCorpus(docs, () => [{
      type: "WELL",
      raw: text,
      index: 0,
      confidence: "medium",
      source: "rule",
    }]);
    expect(report.byVertical.geo!.entity.recall).toBe(0);
    expect(report.byVertical.geo!.sensitiveCoverage.recall).toBe(1);
    expect(report.byVertical.geo!.byTypeSensitiveCoverage.WELL!.recall).toBe(1);
  });

  it("симуляция связывания считает только однозначный публичный match", () => {
    const docs: GoldDocument[] = [
      { id: "1", vertical: "hr", text: "", spans: [], quasi: ["инженер", "Омск"] },
      { id: "2", vertical: "hr", text: "", spans: [], quasi: ["врач", "Тула"] },
    ];
    expect(linkageRisk(docs, [
      { id: "person-1", quasi: ["инженер", "Омск"] },
      { id: "person-2", quasi: ["врач", "Тула"] },
      { id: "person-3", quasi: ["врач", "Тула"] },
    ])).toEqual({ uniquelyLinked: 1, total: 2, rate: 0.5 });
  });

  it("k=5 совпадает с контрольным набором ARX: группы 5, 5, 1", () => {
    const docs = [
      ...Array.from({ length: 5 }, (_, i) => ["a", i]),
      ...Array.from({ length: 5 }, (_, i) => ["b", i]),
      ["c", 0],
    ].map(([group, i]) => ({
      id: `${group}-${i}`,
      vertical: "finance" as const,
      text: "",
      spans: [],
      quasi: [String(group)],
    }));
    expect(quasiRisk(docs, 5)).toEqual({ highRisk: 1, total: 11, rate: 1 / 11 });
  });

  it("release gate падает при регрессии", () => {
    expect(() => assertReleaseThresholds({
      documents: 1,
      byVertical: {
        geo: {
          entity: metrics({ tp: 9, fp: 0, fn: 1 }),
          sensitiveCoverage: metrics({ tp: 9, fp: 0, fn: 1 }),
          token: metrics({ tp: 9, fp: 0, fn: 1 }),
          byType: { PER: metrics({ tp: 9, fp: 0, fn: 1 }) },
          byTypeSensitiveCoverage: { PER: metrics({ tp: 9, fp: 0, fn: 1 }) },
        },
      },
      quasi: { highRisk: 0, total: 1, rate: 0 },
      linkage: { uniquelyLinked: 0, total: 1, rate: 0 },
      roundTrip: { exact: 1, total: 1, accuracy: 1 },
      documentLeakRisk: { geo: 0.1 },
    })).toThrow("PER");
  });
});
