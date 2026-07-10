import { describe, it, expect } from 'bun:test';
import {
  renderPrivacyEnv,
  upsertEnvBlock,
  buildStoredConfig,
  provision,
  type ProvisionIo,
} from './provision';

/** In-memory ФС для проверки provision без диска. */
function memIo(seed: Record<string, string> = {}): ProvisionIo & { files: Record<string, string> } {
  const files = { ...seed };
  return {
    files,
    read: (p) => files[p] ?? '',
    write: (p, d) => {
      files[p] = d;
    },
    exists: (p) => p in files,
  };
}

describe('renderPrivacyEnv', () => {
  it('enable → PRIVACY_MODULE=on + профиль/порт', () => {
    const block = renderPrivacyEnv({ enable: true, profile: 'geo', port: 7090 });
    expect(block).toContain('PRIVACY_MODULE=on');
    expect(block).toContain('PRIVACY_PROFILE=geo');
    expect(block).toContain('PRIVACY_BACKEND_PORT=7090');
    expect(block).toContain('PRIVACY_BACKEND_HOST=127.0.0.1');
  });
  it('disable → PRIVACY_MODULE=off', () => {
    expect(renderPrivacyEnv({ enable: false, profile: 'base' })).toContain('PRIVACY_MODULE=off');
  });
  it('sidecarCmd прокидывается', () => {
    const b = renderPrivacyEnv({ enable: true, profile: 'geo', sidecarCmd: 'python sc.py' });
    expect(b).toContain('PRIVACY_SIDECAR_CMD=python sc.py');
  });
});

describe('upsertEnvBlock', () => {
  it('вставляет блок в пустой .env', () => {
    const out = upsertEnvBlock('', renderPrivacyEnv({ enable: true, profile: 'base' }));
    expect(out).toContain('PRIVACY_MODULE=on');
  });
  it('добавляет к существующему без затирания', () => {
    const out = upsertEnvBlock('FOO=bar\n', renderPrivacyEnv({ enable: true, profile: 'base' }));
    expect(out).toContain('FOO=bar');
    expect(out).toContain('PRIVACY_MODULE=on');
  });
  it('идемпотентен: повторная запись заменяет блок, не дублирует', () => {
    const first = upsertEnvBlock('FOO=bar\n', renderPrivacyEnv({ enable: true, profile: 'base' }));
    const second = upsertEnvBlock(first, renderPrivacyEnv({ enable: false, profile: 'geo' }));
    expect(second.match(/PRIVACY_MODULE=/g)?.length).toBe(1);
    expect(second).toContain('PRIVACY_MODULE=off');
    expect(second).toContain('PRIVACY_PROFILE=geo');
    expect(second).toContain('FOO=bar');
  });
});

describe('buildStoredConfig', () => {
  it('geo → включает text-deid с конфигом координат', () => {
    const cfg = buildStoredConfig('geo');
    expect(cfg.activeProfile).toBe('geo');
    expect(cfg.components['text-deid']).toEqual({ enabled: true, config: { entities: ['COORD', 'PER', 'ORG', 'DATE'] } });
    expect(cfg.components['geo-mask']?.enabled).toBe(true);
  });
  it('legal → geo-mask выключен, есть CASE (№ дел)', () => {
    const cfg = buildStoredConfig('legal');
    expect(cfg.components['geo-mask']?.enabled).toBe(false);
    // CASE — реальная сущность detect.ts (бывш. мнимый CASE_NUM, приведён к реализации)
    expect((cfg.components['text-deid']?.config as { entities: string[] }).entities).toContain('CASE');
  });
  it('неизвестный профиль → бросает', () => {
    expect(() => buildStoredConfig('nope')).toThrow(/Неизвестный профиль/);
  });
});

describe('provision', () => {
  it('пишет .env-блок и store, возвращает summary', () => {
    const io = memIo();
    const res = provision({
      enable: true,
      profile: 'geo',
      port: 7090,
      envPath: '.env',
      storePath: 'secrets/privacy-config.json',
      io,
    });
    expect(res.enabled).toBe(true);
    expect(res.profile).toBe('geo');
    expect(io.files['.env']).toContain('PRIVACY_MODULE=on');
    const store = JSON.parse(io.files['secrets/privacy-config.json']);
    expect(store.activeProfile).toBe('geo');
    expect(res.enabledComponents).toContain('geo-mask');
    expect(res.summary).toContain('профиль "geo"');
  });

  it('disable всё равно раскладывает store (включение потом — один флаг)', () => {
    const io = memIo();
    const res = provision({ enable: false, profile: 'base', envPath: '.env', storePath: 's.json', io });
    expect(res.enabled).toBe(false);
    expect(io.files['.env']).toContain('PRIVACY_MODULE=off');
    expect(io.files['s.json']).toBeDefined();
  });

  it('неизвестный профиль → бросает ДО записи env', () => {
    const io = memIo();
    expect(() => provision({ enable: true, profile: 'xxx', envPath: '.env', storePath: 's.json', io })).toThrow();
    expect(io.files['.env']).toBeUndefined(); // env не тронут
  });
});
