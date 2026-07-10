/**
 * Тесты ConfigStore hooks (envelope + audit).
 * Базовые тесты без hooks — в config-store.test.ts, не трогать.
 */
import { describe, it, expect } from 'bun:test';
import { ConfigStore, memoryStore } from './config-store';
import { generateKek, createKeysComponent } from './components/keys';
import { createEnvelopeComponent, encryptBytes, decryptBytes } from './components/envelope';
import { createAuditComponent } from './components/audit';

describe('ConfigStore (с hooks) — audit hook', () => {
  it('append вызывается после setActiveProfile', () => {
    const audit = createAuditComponent({ now: () => 1 });
    const store = new ConfigStore(memoryStore(), { audit });
    store.setActiveProfile('geo');
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0].entry).toContain('geo');
  });

  it('append вызывается после setComponent', () => {
    const audit = createAuditComponent({ now: () => 1 });
    const store = new ConfigStore(memoryStore(), { audit });
    store.setComponent('text-deid', { enabled: true });
    expect(audit.records()).toHaveLength(1);
  });

  it('несколько изменений → цепочка верна', () => {
    const audit = createAuditComponent({ now: () => 42 });
    const store = new ConfigStore(memoryStore(), { audit });
    store.setActiveProfile('geo');
    store.setActiveProfile('legal');
    store.setComponent('foo', { enabled: true });
    expect(audit.records()).toHaveLength(3);
    expect(audit.verifyChain().ok).toBe(true);
  });
});

describe('ConfigStore (с hooks) — envelope hook', () => {
  it('onEncrypted вызывается; расшифровка == сохранённые данные', async () => {
    const kek = await generateKek();
    const comp = createEnvelopeComponent(kek);
    const encrypted: Uint8Array[] = [];

    const store = new ConfigStore(memoryStore(), {
      envelope: { encryptBytes: async (p) => comp.atRest!(p, {} as never) },
      onEncrypted: (enc) => encrypted.push(enc),
    });

    store.setActiveProfile('geo');
    // Fire-and-forget: ждём микро-таск
    await new Promise(r => setTimeout(r, 20));
    expect(encrypted).toHaveLength(1);

    // Расшифрованный блоб совпадает с данными store
    const dec = await decryptBytes(encrypted[0], kek);
    const parsed = JSON.parse(new TextDecoder().decode(dec));
    expect(parsed.activeProfile).toBe('geo');
  });
});

describe('ConfigStore (с hooks) — нет hooks → легаси-поведение без hooks', () => {
  it('setActiveProfile без hooks работает как прежде', () => {
    const store = new ConfigStore(memoryStore());
    store.setActiveProfile('legal');
    expect(store.get().activeProfile).toBe('legal');
  });
});

describe('ConfigStore (с hooks) — интеграция keys + envelope + audit', () => {
  it('полный стек: store с keys+envelope+audit', async () => {
    const keysComp = createKeysComponent();
    const kek = await keysComp.getKek();
    const envComp = createEnvelopeComponent(kek);
    const auditComp = createAuditComponent({ now: () => 1 });
    const encrypted: Uint8Array[] = [];

    const store = new ConfigStore(memoryStore(), {
      envelope: { encryptBytes: async (p) => envComp.atRest!(p, {} as never) },
      audit: auditComp,
      onEncrypted: (enc) => encrypted.push(enc),
    });

    store.setActiveProfile('geo');
    store.setComponent('envelope', { enabled: true });
    await new Promise(r => setTimeout(r, 20));

    // Аудит: 2 записи, цепочка цела
    expect(auditComp.records()).toHaveLength(2);
    expect(auditComp.verifyChain().ok).toBe(true);

    // Шифрование: 2 вызова
    expect(encrypted).toHaveLength(2);

    // Последний блоб расшифровывается корректно
    const dec = await decryptBytes(encrypted[1], kek);
    const cfg = JSON.parse(new TextDecoder().decode(dec));
    expect(cfg.components['envelope'].enabled).toBe(true);
  });
});
