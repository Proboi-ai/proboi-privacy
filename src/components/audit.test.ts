import { describe, it, expect } from 'bun:test';
import {
  canonicalize,
  GENESIS_HASH,
  buildRecord,
  verifyChain,
  generateAuditKeyPair,
  signCheckpoint,
  verifyCheckpointSig,
  createAuditComponent,
  type AuditRecord,
  type Checkpoint,
} from './audit';

// ─── canonicalize ────────────────────────────────────────────────────────────

describe('canonicalize', () => {
  it('сортирует ключи объекта', () => {
    const r = canonicalize({ b: 2, a: 1 });
    expect(r).toBe('{"a":1,"b":2}');
  });

  it('обрабатывает массивы', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('рекурсивная сортировка вложенных объектов', () => {
    const r = canonicalize({ z: { b: 2, a: 1 }, a: 0 });
    expect(r).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  it('null → "null"', () => {
    expect(canonicalize(null)).toBe('null');
  });

  it('детерминированность: два идентичных объекта → одна строка', () => {
    const obj = { seq: 5, entry: 'x', prevHash: 'abc', ts: 1000 };
    expect(canonicalize(obj)).toBe(canonicalize({ ...obj }));
  });
});

// ─── Hash-chain ───────────────────────────────────────────────────────────────

describe('buildRecord / verifyChain', () => {
  it('первая запись имеет prevHash = GENESIS_HASH', () => {
    const r = buildRecord('hello', 0, GENESIS_HASH, 1000);
    expect(r.prevHash).toBe(GENESIS_HASH);
    expect(r.seq).toBe(0);
    expect(r.hash).toHaveLength(64); // SHA-256 hex
  });

  it('цепочка из 3 записей проходит verifyChain', () => {
    const r0 = buildRecord('a', 0, GENESIS_HASH, 1);
    const r1 = buildRecord('b', 1, r0.hash, 2);
    const r2 = buildRecord('c', 2, r1.hash, 3);
    expect(verifyChain([r0, r1, r2])).toEqual({ ok: true });
  });

  it('пустая цепочка → ok', () => {
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('подмена поля entry → ok:false с правильным brokenAt', () => {
    const r0 = buildRecord('a', 0, GENESIS_HASH, 1);
    const r1 = buildRecord('b', 1, r0.hash, 2);
    const tampered: AuditRecord = { ...r1, entry: 'TAMPERED' };
    expect(verifyChain([r0, tampered])).toEqual({ ok: false, brokenAt: 1 });
  });

  it('подмена hash записи → ok:false', () => {
    const r0 = buildRecord('a', 0, GENESIS_HASH, 1);
    const r1 = buildRecord('b', 1, r0.hash, 2);
    const tampered: AuditRecord = { ...r0, hash: 'badhash' };
    expect(verifyChain([tampered, r1])).toEqual({ ok: false, brokenAt: 0 });
  });

  it('неверный seq → ok:false', () => {
    const r0 = buildRecord('a', 0, GENESIS_HASH, 1);
    const badSeq: AuditRecord = { ...r0, seq: 99 };
    expect(verifyChain([badSeq])).toEqual({ ok: false, brokenAt: 0 });
  });
});

// ─── Ed25519 чекпоинты ───────────────────────────────────────────────────────

describe('signCheckpoint / verifyCheckpointSig', () => {
  it('sign → verify: ok', () => {
    const { privateKey, publicKey } = generateAuditKeyPair();
    const cp: Checkpoint = { seq: 5, lastHash: 'abc123' };
    const sig = signCheckpoint(cp, privateKey);
    expect(verifyCheckpointSig(cp, sig, publicKey)).toBe(true);
  });

  it('порча подписи → verify: false', () => {
    const { privateKey, publicKey } = generateAuditKeyPair();
    const cp: Checkpoint = { seq: 5, lastHash: 'abc123' };
    const sig = signCheckpoint(cp, privateKey);
    // Портим base64: меняем первый символ
    const badSig = 'X' + sig.slice(1);
    expect(verifyCheckpointSig(cp, badSig, publicKey)).toBe(false);
  });

  it('неверный публичный ключ → verify: false', () => {
    const keys1 = generateAuditKeyPair();
    const keys2 = generateAuditKeyPair();
    const cp: Checkpoint = { seq: 1, lastHash: 'xyz' };
    const sig = signCheckpoint(cp, keys1.privateKey);
    expect(verifyCheckpointSig(cp, sig, keys2.publicKey)).toBe(false);
  });
});

// ─── AuditComponent ───────────────────────────────────────────────────────────

describe('createAuditComponent', () => {
  it('id = "audit-logger"', () => {
    const comp = createAuditComponent();
    expect(comp.id).toBe('audit-logger');
  });

  it('append растит цепочку', () => {
    const comp = createAuditComponent({ now: () => 1000 });
    comp.append('first');
    comp.append('second');
    comp.append('third');
    expect(comp.records()).toHaveLength(3);
  });

  it('verifyChain() ok после нескольких append', () => {
    const comp = createAuditComponent({ now: () => 42 });
    comp.append('a');
    comp.append('b');
    comp.append('c');
    expect(comp.verifyChain()).toEqual({ ok: true });
  });

  it('signLastCheckpoint / verifyLastCheckpoint roundtrip', () => {
    const comp = createAuditComponent({ now: () => 1 });
    comp.append('entry1');
    const { cp, sig } = comp.signLastCheckpoint();
    expect(comp.verifyLastCheckpoint(cp, sig)).toBe(true);
  });

  it('порча sig → verifyLastCheckpoint: false', () => {
    const comp = createAuditComponent({ now: () => 1 });
    comp.append('entry1');
    const { cp } = comp.signLastCheckpoint();
    expect(comp.verifyLastCheckpoint(cp, 'badsig')).toBe(false);
  });

  it('signLastCheckpoint на пустой цепочке → throw', () => {
    const comp = createAuditComponent();
    expect(() => comp.signLastCheckpoint()).toThrow();
  });
});
