/**
 * Долговечный DPAPI-защищённый KEK: createKeysComponent({ keyDir, dpapi }).
 * Тесты hermetic — DPAPI ИНЪЕЦИРОВАН фейком (reversible marker-transform), реального
 * Windows-DPAPI здесь нет и не нужно: контракт keys.ts (persist/load через dpapi.protect/
 * unprotect) проверяется независимо от платформы. Реальный DPAPI round-trip живёт в
 * keys.test.ts (test.skipIf(win32)) и проверен отдельно на Windows-стенде.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeysComponent, type DpapiLike } from './keys';

/** Фейковый DPAPI: обратимая метка-обёртка (НЕ реальная защита — только для теста). */
function makeFakeDpapi(): DpapiLike & { protectCalls: number; unprotectCalls: number } {
  const MARKER = 0xaa;
  return {
    protectCalls: 0,
    unprotectCalls: 0,
    async protect(bytes: Uint8Array): Promise<Uint8Array> {
      this.protectCalls++;
      const out = new Uint8Array(bytes.length + 1);
      out[0] = MARKER;
      out.set(bytes, 1);
      return out;
    },
    async unprotect(bytes: Uint8Array): Promise<Uint8Array> {
      this.unprotectCalls++;
      if (bytes[0] !== MARKER) throw new Error('fake dpapi: bad marker');
      return bytes.slice(1);
    },
  };
}

describe('createKeysComponent — долговечный KEK (keyDir + инъекция dpapi)', () => {
  it('первый getKek() создаёт <keyDir>/kek.dpapi через dpapi.protect', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'kek-'));
    const fake = makeFakeDpapi();
    const comp = createKeysComponent({ keyDir, dpapi: fake });

    const kek = await comp.getKek();
    expect(kek).toBeDefined();

    const kekPath = join(keyDir, 'kek.dpapi');
    expect(existsSync(kekPath)).toBe(true);
    expect(readFileSync(kekPath).byteLength).toBeGreaterThan(0);
    expect(fake.protectCalls).toBe(1);
    expect(fake.unprotectCalls).toBe(0);
  });

  it('второй createKeysComponent (свежий, тот же keyDir) ЗАГРУЖАЕТ персистентный ключ', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'kek-'));
    const fake1 = makeFakeDpapi();

    const comp1 = createKeysComponent({ keyDir, dpapi: fake1 });
    const kek1 = await comp1.getKek();

    // Свежая фабрика — своя инъекция dpapi (симулирует новый процесс/рестарт раннера).
    const fake2 = makeFakeDpapi();
    const comp2 = createKeysComponent({ keyDir, dpapi: fake2 });
    const kek2 = await comp2.getKek();

    expect(fake2.protectCalls).toBe(0); // файл уже есть → протект не вызывается повторно
    expect(fake2.unprotectCalls).toBe(1); // а унпротект — да, при загрузке

    const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', kek1));
    const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', kek2));
    expect(raw2).toEqual(raw1);
  });

  it('без keyDir — прежнее поведение: эфемерный, но рабочий KEK (backward-compat)', async () => {
    const comp = createKeysComponent();
    const kek = await comp.getKek();
    expect(kek).toBeDefined();
    expect(kek.algorithm.name).toBe('AES-KW');
    // Повторный вызов на ТОЙ ЖЕ фабрике возвращает тот же ключ (кэш в замыкании).
    const kek2 = await comp.getKek();
    const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', kek));
    const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', kek2));
    expect(raw2).toEqual(raw1);
  });
});

describe('createKeysComponent — Linux-путь: keyDir + keyfilePath (без dpapi-инъекции, БЕЗ Windows)', () => {
  it('первый getKek() создаёт <keyDir>/kek.dpapi через реальный protectWithKeyfile (работает вне Windows)', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'kek-'));
    const keyfileDir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    const keyfilePath = join(keyfileDir, 'kek.passphrase');
    writeFileSync(keyfilePath, 'linux-standard-keyfile-passphrase', { mode: 0o600 });

    // БЕЗ opts.dpapi: без keyfilePath на не-Windows это упало бы fail-closed (см. keys.test.ts).
    const comp = createKeysComponent({ keyDir, keyfilePath });
    const kek = await comp.getKek();
    expect(kek).toBeDefined();

    const kekPath = join(keyDir, 'kek.dpapi');
    expect(existsSync(kekPath)).toBe(true);
    expect(readFileSync(kekPath).byteLength).toBeGreaterThan(0);
  });

  it('второй createKeysComponent (свежий, тот же keyDir+keyfilePath) ЗАГРУЖАЕТ персистентный ключ', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'kek-'));
    const keyfileDir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    const keyfilePath = join(keyfileDir, 'kek.passphrase');
    writeFileSync(keyfilePath, 'reload-passphrase', { mode: 0o600 });

    const comp1 = createKeysComponent({ keyDir, keyfilePath });
    const kek1 = await comp1.getKek();

    const comp2 = createKeysComponent({ keyDir, keyfilePath });
    const kek2 = await comp2.getKek();

    const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', kek1));
    const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', kek2));
    expect(raw2).toEqual(raw1);
  });

  it('неверная passphrase в keyfile при перезагрузке → getKek() бросает (не тихо возвращает мусор)', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'kek-'));
    const keyfileDir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    const keyfilePath = join(keyfileDir, 'kek.passphrase');
    writeFileSync(keyfilePath, 'original-pass', { mode: 0o600 });

    const comp1 = createKeysComponent({ keyDir, keyfilePath });
    await comp1.getKek();

    writeFileSync(keyfilePath, 'wrong-pass', { mode: 0o600 });
    const comp2 = createKeysComponent({ keyDir, keyfilePath });
    await expect(comp2.getKek()).rejects.toThrow();
  });

  it('opts.dpapi (явная инъекция) имеет приоритет над keyfilePath', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'kek-'));
    const keyfileDir = mkdtempSync(join(tmpdir(), 'kek-keyfile-'));
    const keyfilePath = join(keyfileDir, 'kek.passphrase');
    writeFileSync(keyfilePath, 'irrelevant-if-dpapi-wins', { mode: 0o600 });

    const fake = makeFakeDpapi();
    const comp = createKeysComponent({ keyDir, keyfilePath, dpapi: fake });
    await comp.getKek();

    // Явная dpapi-инъекция вызвана, а не keyfile-путь.
    expect(fake.protectCalls).toBe(1);
  });
});
