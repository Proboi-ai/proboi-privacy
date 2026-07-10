import { describe, it, expect } from 'bun:test';
import { ComponentRegistry } from './registry';
import { BASE, GEO, LEGAL, STANDARD, STRICT, BUILTIN_PROFILES, applyProfile } from './profiles';
import type { PrivacyComponent } from './types';

function stub(id: string): PrivacyComponent {
  return { id, tier: 'T0', runtime: 'ts-spine', configSchema: {} };
}

describe('applyProfile', () => {
  it('BASE: включает зарегистрированные компоненты', () => {
    const r = new ComponentRegistry();
    r.register(stub('audit-logger'));
    r.register(stub('envelope'));
    const skipped = applyProfile(r, BASE);
    expect(r.isEnabled('audit-logger')).toBe(true);
    expect(r.isEnabled('envelope')).toBe(true);
    // key-store не зарегистрирован → в skipped
    expect(skipped).toContain('key-store');
  });

  it('GEO: включает geo-mask', () => {
    const r = new ComponentRegistry();
    r.register(stub('geo-mask'));
    r.register(stub('text-deid'));
    r.register(stub('scan-redact'));
    const skipped = applyProfile(r, GEO);
    expect(r.isEnabled('geo-mask')).toBe(true);
    expect(r.isEnabled('text-deid')).toBe(true);
    // незарегистрированные - в skipped
    expect(skipped).toContain('audit-logger');
  });

  it('LEGAL: geo-mask выключен', () => {
    const r = new ComponentRegistry();
    r.register(stub('geo-mask'));
    r.register(stub('text-deid'));
    r.setEnabled('geo-mask', true); // предварительно включим
    applyProfile(r, LEGAL);
    expect(r.isEnabled('geo-mask')).toBe(false);
  });

  it('неизвестные id возвращаются как пропущенные', () => {
    const r = new ComponentRegistry();
    // реестр пустой
    const skipped = applyProfile(r, GEO);
    expect(skipped).toContain('geo-mask');
    expect(skipped).toContain('text-deid');
    expect(skipped).toContain('scan-redact');
  });

  it('уже включённый компонент выключается если профиль ставит enabled:false', () => {
    const r = new ComponentRegistry();
    r.register(stub('geo-mask'));
    r.setEnabled('geo-mask', true);
    applyProfile(r, LEGAL); // LEGAL: geo-mask enabled:false
    expect(r.isEnabled('geo-mask')).toBe(false);
  });

  it('STANDARD: включает text-deid (ФИО+организации), но не scan-redact/geo-mask', () => {
    const r = new ComponentRegistry();
    r.register(stub('audit-logger'));
    r.register(stub('envelope'));
    r.register(stub('key-store'));
    r.register(stub('text-deid'));
    const skipped = applyProfile(r, STANDARD);
    expect(r.isEnabled('text-deid')).toBe(true);
    expect(STANDARD.components['text-deid']?.config).toEqual({ entities: ['PER', 'ORG'] });
    expect(skipped).toEqual([]);
    expect(STANDARD.components['scan-redact']).toBeUndefined();
    expect(STANDARD.components['geo-mask']).toBeUndefined();
  });

  it('STRICT: включает text-deid (максимум entity-типов) + scan-redact, geo-mask выключен', () => {
    const r = new ComponentRegistry();
    r.register(stub('audit-logger'));
    r.register(stub('envelope'));
    r.register(stub('key-store'));
    r.register(stub('text-deid'));
    r.register(stub('scan-redact'));
    r.register(stub('geo-mask'));
    r.setEnabled('geo-mask', true); // предварительно включим
    applyProfile(r, STRICT);
    expect(r.isEnabled('text-deid')).toBe(true);
    expect(r.isEnabled('scan-redact')).toBe(true);
    expect(r.isEnabled('geo-mask')).toBe(false);
    expect(STRICT.components['text-deid']?.config).toEqual({
      entities: ['PER', 'ORG', 'DATE', 'CASE', 'COORD'],
    });
  });

  it('BUILTIN_PROFILES содержит все 5 профилей (base/geo/legal/standard/strict)', () => {
    expect(BUILTIN_PROFILES.map((p) => p.id).sort()).toEqual(
      ['base', 'geo', 'legal', 'standard', 'strict'].sort(),
    );
  });
});
