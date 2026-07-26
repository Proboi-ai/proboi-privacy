import type { DetectedEntity } from "./deid/detect";
import type { EntityType, Vertical } from "./deid/entities";
import { detokenizeText, tokenizeEntities } from "./components/text-deid";
import { TokenVault } from "./vault";

export interface GoldSpan {
  type: EntityType;
  start: number;
  end: number;
}

export interface GoldDocument {
  id: string;
  vertical: Exclude<Vertical, "common">;
  text: string;
  spans: GoldSpan[];
  quasi: string[];
}

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export interface Metrics extends Counts {
  precision: number;
  recall: number;
  f1: number;
  f2: number;
}

export interface ValidationReport {
  documents: number;
  byVertical: Record<string, {
    /** Strict type + boundary match, retained for boundary diagnostics. */
    entity: Metrics;
    /** Prediction covers every alphanumeric character in the gold span. */
    sensitiveCoverage: Metrics;
    token: Metrics;
    byType: Partial<Record<EntityType, Metrics>>;
    byTypeSensitiveCoverage: Partial<Record<EntityType, Metrics>>;
  }>;
  quasi: { highRisk: number; total: number; rate: number };
  linkage: { uniquelyLinked: number; total: number; rate: number };
  roundTrip: { exact: number; total: number; accuracy: number };
  documentLeakRisk: Record<string, number>;
}

export interface PublicRecord {
  id: string;
  quasi: string[];
}

const divide = (n: number, d: number): number => d === 0 ? 0 : n / d;

export function metrics({ tp, fp, fn }: Counts): Metrics {
  const precision = tp + fp === 0 ? 1 : divide(tp, tp + fp);
  const recall = tp + fn === 0 ? 1 : divide(tp, tp + fn);
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: divide(2 * precision * recall, precision + recall),
    f2: divide(5 * precision * recall, 4 * precision + recall),
  };
}

function key(type: string, start: number, end: number): string {
  return `${type}\0${start}\0${end}`;
}

function add(target: Counts, source: Counts): void {
  target.tp += source.tp;
  target.fp += source.fp;
  target.fn += source.fn;
}

function countMatches(gold: GoldSpan[], predicted: DetectedEntity[]): Counts {
  const expected = new Set(gold.map((s) => key(s.type, s.start, s.end)));
  const actual = new Set(predicted.map((s) => key(s.type, s.index, s.index + s.raw.length)));
  let tp = 0;
  for (const item of actual) if (expected.has(item)) tp++;
  return { tp, fp: actual.size - tp, fn: expected.size - tp };
}

function sensitiveBounds(text: string, span: GoldSpan): [number, number] {
  let start = span.start;
  let end = span.end;
  while (start < end && !/[\p{L}\p{N}]/u.test(text[start]!)) start++;
  while (end > start && !/[\p{L}\p{N}]/u.test(text[end - 1]!)) end--;
  return [start, end];
}

function countSensitiveCoverage(
  text: string,
  gold: GoldSpan[],
  predicted: DetectedEntity[],
): Counts {
  const used = new Set<number>();
  let tp = 0;
  for (const target of gold) {
    const [sensitiveStart, sensitiveEnd] = sensitiveBounds(text, target);
    const index = predicted.findIndex((candidate, candidateIndex) =>
      !used.has(candidateIndex) &&
      candidate.type === target.type &&
      candidate.index <= sensitiveStart &&
      candidate.index + candidate.raw.length >= sensitiveEnd
    );
    if (index >= 0) {
      used.add(index);
      tp++;
    }
  }
  return { tp, fp: predicted.length - used.size, fn: gold.length - tp };
}

function tokenKeys(text: string, spans: Array<{ type: EntityType; start: number; end: number }>): Set<string> {
  const out = new Set<string>();
  for (const span of spans) {
    const raw = text.slice(span.start, span.end);
    for (const match of raw.matchAll(/\S+/gu)) {
      out.add(key(span.type, span.start + match.index, span.start + match.index + match[0].length));
    }
  }
  return out;
}

function tokenCounts(
  text: string,
  gold: GoldSpan[],
  predicted: DetectedEntity[],
): Counts {
  const expected = tokenKeys(text, gold);
  const actual = tokenKeys(
    text,
    predicted.map((s) => ({ type: s.type, start: s.index, end: s.index + s.raw.length })),
  );
  let tp = 0;
  for (const item of actual) if (expected.has(item)) tp++;
  return { tp, fp: actual.size - tp, fn: expected.size - tp };
}

export function quasiRisk(documents: GoldDocument[], k = 5): ValidationReport["quasi"] {
  const frequencies = new Map<string, number>();
  for (const doc of documents) {
    const signature = JSON.stringify(doc.quasi);
    frequencies.set(signature, (frequencies.get(signature) ?? 0) + 1);
  }
  const highRisk = documents.filter(
    (doc) => (frequencies.get(JSON.stringify(doc.quasi)) ?? 0) < k,
  ).length;
  return { highRisk, total: documents.length, rate: divide(highRisk, documents.length) };
}

export function linkageRisk(
  documents: GoldDocument[],
  publicRecords: PublicRecord[],
): ValidationReport["linkage"] {
  const idsBySignature = new Map<string, Set<string>>();
  for (const record of publicRecords) {
    const signature = JSON.stringify(record.quasi);
    const ids = idsBySignature.get(signature) ?? new Set<string>();
    ids.add(record.id);
    idsBySignature.set(signature, ids);
  }
  const uniquelyLinked = documents.filter(
    (doc) => idsBySignature.get(JSON.stringify(doc.quasi))?.size === 1,
  ).length;
  return {
    uniquelyLinked,
    total: documents.length,
    rate: divide(uniquelyLinked, documents.length),
  };
}

export function scoreCorpus(
  documents: GoldDocument[],
  predict: (document: GoldDocument) => DetectedEntity[],
  publicRecords: PublicRecord[] = [],
): ValidationReport {
  const byVertical: ValidationReport["byVertical"] = {};
  let roundTripExact = 0;
  for (const doc of documents) {
    const vertical = byVertical[doc.vertical] ??= {
      entity: metrics({ tp: 0, fp: 0, fn: 0 }),
      sensitiveCoverage: metrics({ tp: 0, fp: 0, fn: 0 }),
      token: metrics({ tp: 0, fp: 0, fn: 0 }),
      byType: {},
      byTypeSensitiveCoverage: {},
    };
    const predicted = predict(doc);
    const vault = new TokenVault();
    const tokenized = tokenizeEntities(doc.text, predicted, vault).text;
    if (detokenizeText(tokenized, vault) === doc.text) roundTripExact++;
    const entity = countMatches(doc.spans, predicted);
    const sensitiveCoverage = countSensitiveCoverage(doc.text, doc.spans, predicted);
    const token = tokenCounts(doc.text, doc.spans, predicted);
    const entityCounts: Counts = vertical.entity;
    const sensitiveCoverageCounts: Counts = vertical.sensitiveCoverage;
    const tokenAggregate: Counts = vertical.token;
    add(entityCounts, entity);
    add(sensitiveCoverageCounts, sensitiveCoverage);
    add(tokenAggregate, token);
    for (const type of new Set([
      ...doc.spans.map((s) => s.type),
      ...predicted.map((s) => s.type),
    ])) {
      const typedGold = doc.spans.filter((s) => s.type === type);
      const typedPredicted = predicted.filter((s) => s.type === type);
      const current = vertical.byType[type] ?? metrics({ tp: 0, fp: 0, fn: 0 });
      add(current, countMatches(typedGold, typedPredicted));
      vertical.byType[type] = current;
      const currentSensitive = vertical.byTypeSensitiveCoverage[type] ??
        metrics({ tp: 0, fp: 0, fn: 0 });
      add(currentSensitive, countSensitiveCoverage(doc.text, typedGold, typedPredicted));
      vertical.byTypeSensitiveCoverage[type] = currentSensitive;
    }
  }
  for (const vertical of Object.values(byVertical)) {
    vertical.entity = metrics(vertical.entity);
    vertical.sensitiveCoverage = metrics(vertical.sensitiveCoverage);
    vertical.token = metrics(vertical.token);
    for (const [type, counts] of Object.entries(vertical.byType)) {
      vertical.byType[type as EntityType] = metrics(counts!);
    }
    for (const [type, counts] of Object.entries(vertical.byTypeSensitiveCoverage)) {
      vertical.byTypeSensitiveCoverage[type as EntityType] = metrics(counts!);
    }
  }
  const documentLeakRisk: Record<string, number> = {};
  for (const [name, vertical] of Object.entries(byVertical)) {
    const recalls = Object.values(vertical.byTypeSensitiveCoverage).map((value) => value!.recall);
    const weakestRecall = recalls.length ? Math.min(...recalls) : 1;
    const maxEntities = Math.max(
      ...documents.filter((doc) => doc.vertical === name).map((doc) => doc.spans.length),
      0,
    );
    documentLeakRisk[name] = 1 - weakestRecall ** maxEntities;
  }
  return {
    documents: documents.length,
    byVertical,
    quasi: quasiRisk(documents),
    linkage: linkageRisk(documents, publicRecords),
    roundTrip: {
      exact: roundTripExact,
      total: documents.length,
      accuracy: divide(roundTripExact, documents.length),
    },
    documentLeakRisk,
  };
}

export function assertReleaseThresholds(report: ValidationReport): void {
  for (const vertical of Object.values(report.byVertical)) {
    if (vertical.sensitiveCoverage.precision < 0.85) {
      throw new Error("sensitive_coverage precision ниже 0.85");
    }
    for (const [type, value] of Object.entries(vertical.byTypeSensitiveCoverage)) {
      const threshold =
        type === "PER" ? 0.99 :
        type === "ORG" ? 0.97 :
        type === "ADDR" ? 0.90 : 0.98;
      if (value!.recall < threshold) {
        throw new Error(`${type}: recall ${value!.recall.toFixed(3)} ниже ${threshold}`);
      }
    }
  }
  if (report.quasi.rate > 0.05) {
    throw new Error(`quasi high-risk ${(report.quasi.rate * 100).toFixed(1)}% выше 5%`);
  }
  if (report.linkage.rate > 0.05) {
    throw new Error(`linkage risk ${(report.linkage.rate * 100).toFixed(1)}% выше 5%`);
  }
  if (report.roundTrip.accuracy < 0.999) {
    throw new Error(`round-trip ${report.roundTrip.accuracy.toFixed(4)} ниже 0.999`);
  }
}
