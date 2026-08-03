import { describe, it, expect } from 'bun:test';
import { bootstrapPrivacy } from './bootstrap';
import { ConfigStore, memoryStore } from './config-store';

const OFF = { PRIVACY_MODULE: 'off' } as Record<string, string>;

describe('bootstrapPrivacy — деплой-opt-in', () => {
  it('off → инертный handle: ничего не собрано, не слушает порт', async () => {
    const h = await bootstrapPrivacy({ env: {} }); // PRIVACY_MODULE не задан → off
    expect(h.enabled).toBe(false);
    expect(h.module).toBeUndefined();
    expect(h.port).toBeUndefined();
    await h.stop(); // no-op, не бросает
  });

  it('явный off тоже инертен', async () => {
    const h = await bootstrapPrivacy({ env: OFF });
    expect(h.enabled).toBe(false);
    await h.stop();
  });

  it('on → полная сборка: 6 компонентов зарегистрированы', async () => {
    const h = await bootstrapPrivacy({
      env: { PRIVACY_MODULE: 'on', PRIVACY_PROFILE: 'base' },
      store: new ConfigStore(memoryStore()),
      startBackend: false,
    });
    expect(h.enabled).toBe(true);
    const ids = h.module!.registry.list().map((c) => c.id).sort();
    expect(ids).toEqual(['audit-logger', 'envelope', 'geo-mask', 'key-store', 'scan-redact', 'text-deid']);
    await h.stop();
  });

  it('профиль base включает envelope/key-store/audit, но не text-deid/geo-mask', async () => {
    const h = await bootstrapPrivacy({
      env: { PRIVACY_MODULE: 'on', PRIVACY_PROFILE: 'base' },
      store: new ConfigStore(memoryStore()),
      startBackend: false,
    });
    const reg = h.module!.registry;
    expect(reg.isEnabled('envelope')).toBe(true);
    expect(reg.isEnabled('key-store')).toBe(true);
    expect(reg.isEnabled('audit-logger')).toBe(true);
    expect(reg.isEnabled('text-deid')).toBe(false);
    expect(reg.isEnabled('geo-mask')).toBe(false);
    expect(h.module!.store.get().activeProfile).toBe('base');
    await h.stop();
  });

  it('профиль geo из env → text-deid+geo-mask включены, конфиг доходит до компонента', async () => {
    const store = new ConfigStore(memoryStore());
    const h = await bootstrapPrivacy({
      env: { PRIVACY_MODULE: 'on', PRIVACY_PROFILE: 'geo' },
      store,
      startBackend: false,
    });
    const reg = h.module!.registry;
    expect(reg.isEnabled('text-deid')).toBe(true);
    expect(reg.isEnabled('geo-mask')).toBe(true);
    // store засеян vertical-профилем — text-deid развернёт полный отраслевой реестр
    expect(store.get().components['text-deid']?.config).toEqual({ vertical: 'geo' });
    await h.stop();
  });
  it('PRIVACY_VERTICAL заменяет legacy entities в свежем store', async () => {
    const h = await bootstrapPrivacy({
      env: {
        PRIVACY_MODULE: 'on',
        PRIVACY_PROFILE: 'standard',
        PRIVACY_VERTICAL: 'finance',
      },
      startBackend: false,
    });
    expect(h.module?.store.get().components['text-deid']?.config).toMatchObject({
      vertical: 'finance',
    });
    expect(h.module?.store.get().components['text-deid']?.config.entities).toBeUndefined();
    await h.stop();
  });

  it('persisted store авторитетен над env-профилем', async () => {
    // store уже содержит выбор оператора: только audit, профиль legal
    const store = new ConfigStore(
      memoryStore({
        activeProfile: 'legal',
        components: { 'audit-logger': { enabled: true, config: {} }, envelope: { enabled: false, config: {} } },
      }),
    );
    const h = await bootstrapPrivacy({
      env: { PRIVACY_MODULE: 'on', PRIVACY_PROFILE: 'geo' }, // env говорит geo, но store важнее
      store,
      startBackend: false,
    });
    const reg = h.module!.registry;
    expect(reg.isEnabled('audit-logger')).toBe(true);
    expect(reg.isEnabled('envelope')).toBe(false); // из store, не из geo-профиля
    expect(reg.isEnabled('geo-mask')).toBe(false); // geo-профиль проигнорирован
    await h.stop();
  });

  it('startBackend=true → слушает эфемерный порт, stop() закрывает', async () => {
    const h = await bootstrapPrivacy({
      env: { PRIVACY_MODULE: 'on', PRIVACY_PROFILE: 'base' },
      store: new ConfigStore(memoryStore()),
      startBackend: true,
    });
    expect(h.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${h.port}/components`);
    expect(res.status).toBe(200);
    await h.stop();
  });

  it('без sidecarCmd сайдкар absent (fail-closed, но не крашит сборку)', async () => {
    const h = await bootstrapPrivacy({
      env: { PRIVACY_MODULE: 'on' },
      store: new ConfigStore(memoryStore()),
      startBackend: false,
    });
    expect(h.module!.sidecar.status()).toBe('absent');
    await h.stop();
  });

  it('stop идемпотентен', async () => {
    const h = await bootstrapPrivacy({
      env: { PRIVACY_MODULE: 'on' },
      store: new ConfigStore(memoryStore()),
      startBackend: false,
    });
    await h.stop();
    await h.stop(); // повторно — не бросает
  });
});
