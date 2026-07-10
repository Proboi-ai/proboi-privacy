import { describe, it, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKek,
  wrapKekWithPassphrase,
  unwrapKekWithPassphrase,
  protectWithDpapi,
  unprotectWithDpapi,
  dpapiAvailable,
  protectWithKeyfile,
  unprotectWithKeyfile,
  createKeysComponent,
} from './keys';

describe('generateKek', () => {
  it('возвращает CryptoKey AES-KW', async () => {
    const kek = await generateKek();
    expect(kek).toBeDefined();
    expect(kek.type).toBe('secret');
    expect(kek.algorithm.name).toBe('AES-KW');
  });
});

describe('wrapKekWithPassphrase / unwrapKekWithPassphrase', () => {
  it('roundtrip: разворачиваем тот же ключ', async () => {
    const kek = await generateKek();
    const wrapped = await wrapKekWithPassphrase(kek, 'p@ssw0rd');
    const kek2 = await unwrapKekWithPassphrase(wrapped, 'p@ssw0rd');
    // Проверяем через экспорт raw: оба ключа идентичны
    const raw1 = await crypto.subtle.exportKey('raw', kek);
    const raw2 = await crypto.subtle.exportKey('raw', kek2);
    expect(new Uint8Array(raw1)).toEqual(new Uint8Array(raw2));
  });

  it('неверный пароль → unwrap бросает', async () => {
    const kek = await generateKek();
    const wrapped = await wrapKekWithPassphrase(kek, 'correctPass');
    await expect(unwrapKekWithPassphrase(wrapped, 'wrongPass')).rejects.toThrow();
  });

  it('два wrap с одним паролем → разные байты (разная соль)', async () => {
    const kek = await generateKek();
    const w1 = await wrapKekWithPassphrase(kek, 'pass');
    const w2 = await wrapKekWithPassphrase(kek, 'pass');
    expect(w1).not.toEqual(w2);
  });
});

describe('DPAPI gating вне Windows (fail-closed по умолчанию)', () => {
  it('dpapiAvailable() = false вне Windows, true на Windows', () => {
    expect(dpapiAvailable()).toBe(process.platform === 'win32');
  });

  it('protectWithDpapi без флага → fail-closed (throw), не тихий no-op', async () => {
    if (process.platform === 'win32') return; // на Windows реальный DPAPI
    const data = new TextEncoder().encode('sensitive');
    await expect(protectWithDpapi(data)).rejects.toThrow(/fail-closed|Windows/);
  });

  it('unprotectWithDpapi без флага → fail-closed (throw)', async () => {
    if (process.platform === 'win32') return;
    await expect(unprotectWithDpapi(new Uint8Array([1, 2, 3]))).rejects.toThrow(/fail-closed|Windows/);
  });

  it('с явным allowInsecureDevFallback → dev-фолбэк возвращает те же байты', async () => {
    if (process.platform === 'win32') return;
    const data = new TextEncoder().encode('sensitive');
    const prot = await protectWithDpapi(data, { allowInsecureDevFallback: true });
    expect(prot).toEqual(data);
    const unprot = await unprotectWithDpapi(prot, { allowInsecureDevFallback: true });
    expect(unprot).toEqual(data);
  });

  it('PRIVACY_ALLOW_INSECURE_KEYS=1 включает dev-фолбэк без опции', async () => {
    if (process.platform === 'win32') return;
    const prev = process.env.PRIVACY_ALLOW_INSECURE_KEYS;
    process.env.PRIVACY_ALLOW_INSECURE_KEYS = '1';
    try {
      const data = new Uint8Array([9, 8, 7]);
      expect(await protectWithDpapi(data)).toEqual(data);
    } finally {
      if (prev === undefined) delete process.env.PRIVACY_ALLOW_INSECURE_KEYS;
      else process.env.PRIVACY_ALLOW_INSECURE_KEYS = prev;
    }
  });
});

describe('protectWithKeyfile / unprotectWithKeyfile (Linux-путь хранения KEK вместо DPAPI)', () => {
  it('roundtrip: работает на ЛЮБОЙ платформе (не только Windows)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    try {
      const keyfilePath = join(dir, 'kek.passphrase');
      writeFileSync(keyfilePath, 'correct horse battery staple', { mode: 0o600 });
      const data = new TextEncoder().encode('sensitive-kek-bytes');

      const protectedBytes = await protectWithKeyfile(data, keyfilePath);
      expect(protectedBytes).not.toEqual(data); // реально зашифровано, не no-op

      const restored = await unprotectWithKeyfile(protectedBytes, keyfilePath);
      expect(restored).toEqual(data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('два protect с одним keyfile → разные байты (разная соль/nonce)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    try {
      const keyfilePath = join(dir, 'kek.passphrase');
      writeFileSync(keyfilePath, 'same-pass', { mode: 0o600 });
      const data = new TextEncoder().encode('same-input');
      const p1 = await protectWithKeyfile(data, keyfilePath);
      const p2 = await protectWithKeyfile(data, keyfilePath);
      expect(p1).not.toEqual(p2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('другая passphrase в keyfile → unprotect бросает (GCM-тег не сойдётся)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    try {
      const keyfilePath = join(dir, 'kek.passphrase');
      writeFileSync(keyfilePath, 'right-pass', { mode: 0o600 });
      const data = new TextEncoder().encode('sensitive');
      const protectedBytes = await protectWithKeyfile(data, keyfilePath);

      writeFileSync(keyfilePath, 'wrong-pass', { mode: 0o600 });
      await expect(unprotectWithKeyfile(protectedBytes, keyfilePath)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('несуществующий keyfile → protect fail-closed (throw, не тихий no-op)', async () => {
    const data = new TextEncoder().encode('sensitive');
    await expect(
      protectWithKeyfile(data, join(tmpdir(), 'definitely-missing-kek-keyfile-xyz')),
    ).rejects.toThrow(/keyfile не найден/);
  });

  it('пустой keyfile → protect бросает', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    try {
      const keyfilePath = join(dir, 'empty');
      writeFileSync(keyfilePath, '', { mode: 0o600 });
      const data = new TextEncoder().encode('sensitive');
      await expect(protectWithKeyfile(data, keyfilePath)).rejects.toThrow(/пуст/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('права шире 0600 → НЕ блокирует protect (только громкий warn, chmod — забота оператора)', async () => {
    if (process.platform === 'win32') return; // Unix-биты прав неприменимы
    const dir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    try {
      const keyfilePath = join(dir, 'kek.passphrase');
      writeFileSync(keyfilePath, 'pass', { mode: 0o644 });
      const data = new TextEncoder().encode('sensitive');
      await expect(protectWithKeyfile(data, keyfilePath)).resolves.toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Реальный DPAPI round-trip — только на реальном Windows-стенде
test.skipIf(process.platform !== 'win32')('DPAPI roundtrip (Windows): protect→unprotect == оригинал', async () => {
  const data = new TextEncoder().encode('windows-protected-data');
  const protected_ = await protectWithDpapi(data);
  // Реальный DPAPI меняет байты (шифртекст), не no-op
  expect(protected_).not.toEqual(data);
  const unprotected = await unprotectWithDpapi(protected_);
  expect(unprotected).toEqual(data);
});

describe('createKeysComponent', () => {
  it('id = "key-store"', async () => {
    const kek = await generateKek();
    const comp = createKeysComponent({ kek });
    expect(comp.id).toBe('key-store');
  });

  it('available() = true если KEK передан', async () => {
    const kek = await generateKek();
    const comp = createKeysComponent({ kek });
    expect(comp.available!()).toBe(true);
  });

  it('available() = false если KEK не передан изначально', () => {
    const comp = createKeysComponent();
    expect(comp.available!()).toBe(false);
  });

  it('getKek() генерирует KEK при первом вызове', async () => {
    const comp = createKeysComponent();
    const kek = await comp.getKek();
    expect(kek).toBeDefined();
    // Второй вызов возвращает тот же ключ
    const kek2 = await comp.getKek();
    const r1 = await crypto.subtle.exportKey('raw', kek);
    const r2 = await crypto.subtle.exportKey('raw', kek2);
    expect(new Uint8Array(r1)).toEqual(new Uint8Array(r2));
  });
});
