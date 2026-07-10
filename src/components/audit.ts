/**
 * Tamper-evident hash-chain + Ed25519 чекпоинты.
 *
 * Записи: SHA-256(canonical({seq,prevHash,ts,entry})) образуют линейную цепочку.
 * Чекпоинт: Ed25519-подпись последнего {seq, hash} — периодически, не каждая запись.
 *
 * canonical() — собственная реализация (сортировка ключей рекурсивно, без пробелов).
 *   TODO: строгий RFC 8785 JSON Canonicalization Scheme позже.
 *
 * Грабли: hash-chain tamper-evident (обнаруживает подмену), но не proof-of-integrity
 *   без внешнего якоря. Якорение вовне — отдельная задача на будущее.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { PrivacyComponent, ComponentContext } from '../types';

// ─── Типы ───────────────────────────────────────────────────────────────────

export interface AuditRecord {
  seq: number;
  prevHash: string; // SHA-256 hex предыдущей записи (или GENESIS_HASH для seq=0)
  ts: number;       // unix ms
  entry: string;    // произвольная строка
  hash: string;     // SHA-256 hex canonical({seq,prevHash,ts,entry})
}

export interface Checkpoint {
  seq: number;
  lastHash: string;
}

// ─── Canonical JSON ──────────────────────────────────────────────────────────

/**
 * Детерминированная сериализация: ключи объектов сортируются рекурсивно,
 * пробелы не используются.
 */
export function canonicalize(val: unknown): string {
  if (val === null) return 'null';
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalize).join(',') + ']';
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val as object).sort();
    const pairs = keys.map(
      k => JSON.stringify(k) + ':' + canonicalize((val as Record<string, unknown>)[k]),
    );
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(val);
}

// ─── Hash-chain ──────────────────────────────────────────────────────────────

/** Genesis-якорь: SHA-256 от известной константы. seq=0 использует как prevHash. */
export const GENESIS_HASH = createHash('sha256')
  .update('privacy-audit-genesis-v1')
  .digest('hex');

function computeRecordHash(r: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256')
    .update(canonicalize({ seq: r.seq, prevHash: r.prevHash, ts: r.ts, entry: r.entry }))
    .digest('hex');
}

/**
 * Создаёт следующую запись в цепочке.
 * prevHash и seq для детерминизма в тестах инжектируются снаружи.
 */
export function buildRecord(
  entry: string,
  seq: number,
  prevHash: string,
  ts: number,
): AuditRecord {
  const partial = { seq, prevHash, ts, entry };
  return { ...partial, hash: computeRecordHash(partial) };
}

/**
 * Проверяет линейную цепочку записей.
 * Возвращает { ok: true } или { ok: false, brokenAt: index }.
 */
export function verifyChain(records: AuditRecord[]): { ok: boolean; brokenAt?: number } {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.seq !== i) return { ok: false, brokenAt: i };
    if (r.prevHash !== prevHash) return { ok: false, brokenAt: i };
    const expected = computeRecordHash(r);
    if (r.hash !== expected) return { ok: false, brokenAt: i };
    prevHash = r.hash;
  }
  return { ok: true };
}

// ─── Ed25519 чекпоинты ───────────────────────────────────────────────────────

export interface AuditKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Генерирует Ed25519-пару для подписи чекпоинтов. */
export function generateAuditKeyPair(): AuditKeyPair {
  return generateKeyPairSync('ed25519');
}

/**
 * Подписывает чекпоинт приватным ключом Ed25519.
 * Используем crypto.sign(null, data, key) — Ed25519 не нуждается в отдельном хеш-дайджесте.
 * Возвращает base64-строку подписи.
 */
export function signCheckpoint(cp: Checkpoint, privateKey: KeyObject): string {
  const data = Buffer.from(canonicalize(cp), 'utf8');
  return cryptoSign(null, data, privateKey).toString('base64');
}

/**
 * Проверяет Ed25519-подпись чекпоинта.
 * Неверная подпись или испорченные данные → false.
 */
export function verifyCheckpointSig(
  cp: Checkpoint,
  sig: string,
  publicKey: KeyObject,
): boolean {
  try {
    const data = Buffer.from(canonicalize(cp), 'utf8');
    return cryptoVerify(null, data, publicKey, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

// ─── PrivacyComponent ────────────────────────────────────────────────────────

/** Расширенный интерфейс компонента: аудит-цепочка + чекпоинты. */
export interface AuditComponent extends PrivacyComponent {
  /** Добавляет запись в цепочку; ts — для детерминизма в тестах. */
  append(entry: string, ts?: number): AuditRecord;
  /** Проверяет целостность накопленных записей. */
  verifyChain(): { ok: boolean; brokenAt?: number };
  /** Подписывает последний hash + seq приватным ключом компонента. */
  signLastCheckpoint(): { cp: Checkpoint; sig: string };
  /** Проверяет подпись чекпоинта публичным ключом компонента. */
  verifyLastCheckpoint(cp: Checkpoint, sig: string): boolean;
  /** Все накопленные записи (readonly). */
  records(): readonly AuditRecord[];
}

/**
 * Фабрика: PrivacyComponent 'audit-logger'.
 * keyPair инжектируется для тестов; если не передан — генерируется автоматически.
 */
export function createAuditComponent(opts?: { keyPair?: AuditKeyPair; now?: () => number }): AuditComponent {
  const _records: AuditRecord[] = [];
  const _keys: AuditKeyPair = opts?.keyPair ?? generateAuditKeyPair();
  const _now = opts?.now ?? (() => Date.now());

  return {
    id: 'audit-logger',
    tier: 'T0',
    runtime: 'ts-spine',
    configSchema: { type: 'object', properties: {} },

    // beforeEgress: логируем исходящие запросы в цепочку
    beforeEgress(p, _ctx: ComponentContext) {
      this.append(`egress:${p.kind}`);
      return p;
    },

    append(entry: string, ts?: number): AuditRecord {
      const seq = _records.length;
      const prevHash = seq === 0 ? GENESIS_HASH : _records[seq - 1].hash;
      const record = buildRecord(entry, seq, prevHash, ts ?? _now());
      _records.push(record);
      return record;
    },

    verifyChain(): { ok: boolean; brokenAt?: number } {
      return verifyChain(_records);
    },

    signLastCheckpoint(): { cp: Checkpoint; sig: string } {
      if (_records.length === 0) throw new Error('Цепочка пуста — нечего подписывать');
      const last = _records[_records.length - 1];
      const cp: Checkpoint = { seq: last.seq, lastHash: last.hash };
      const sig = signCheckpoint(cp, _keys.privateKey);
      return { cp, sig };
    },

    verifyLastCheckpoint(cp: Checkpoint, sig: string): boolean {
      return verifyCheckpointSig(cp, sig, _keys.publicKey);
    },

    records(): readonly AuditRecord[] {
      return _records;
    },
  };
}
