import { describe, it, expect } from 'bun:test';
import { ComponentRegistry } from './registry';
import type { PrivacyComponent } from './types';

function stub(id: string, requires?: string[]): PrivacyComponent {
  return { id, tier: 'T0', runtime: 'ts-spine', requires, configSchema: {} };
}

describe('ComponentRegistry', () => {
  it('register / get / list / has', () => {
    const r = new ComponentRegistry();
    const c = stub('foo');
    r.register(c);
    expect(r.has('foo')).toBe(true);
    expect(r.get('foo')).toBe(c);
    expect(r.list()).toHaveLength(1);
    expect(r.has('bar')).toBe(false);
  });

  it('дефолт enabled=false', () => {
    const r = new ComponentRegistry();
    r.register(stub('foo'));
    expect(r.isEnabled('foo')).toBe(false);
  });

  it('setEnabled включает и выключает', () => {
    const r = new ComponentRegistry();
    r.register(stub('foo'));
    r.setEnabled('foo', true);
    expect(r.isEnabled('foo')).toBe(true);
    r.setEnabled('foo', false);
    expect(r.isEnabled('foo')).toBe(false);
  });

  it('setEnabled на незарегистрированный → ошибка', () => {
    const r = new ComponentRegistry();
    expect(() => r.setEnabled('ghost', true)).toThrow();
  });

  it('resolveOrder: нет включённых → пустой массив', () => {
    const r = new ComponentRegistry();
    r.register(stub('a'));
    expect(r.resolveOrder()).toHaveLength(0);
  });

  it('resolveOrder: топологический порядок без зависимостей', () => {
    const r = new ComponentRegistry();
    r.register(stub('a'));
    r.register(stub('b'));
    r.setEnabled('a', true);
    r.setEnabled('b', true);
    const order = r.resolveOrder().map(c => c.id);
    expect(order).toContain('a');
    expect(order).toContain('b');
  });

  it('resolveOrder: b requires a → a идёт первым', () => {
    const r = new ComponentRegistry();
    r.register(stub('a'));
    r.register(stub('b', ['a']));
    r.setEnabled('a', true);
    r.setEnabled('b', true);
    const order = r.resolveOrder().map(c => c.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });

  it('resolveOrder: включённый с неизвестной зависимостью → ошибка', () => {
    const r = new ComponentRegistry();
    r.register(stub('b', ['missing']));
    r.setEnabled('b', true);
    expect(() => r.resolveOrder()).toThrow(/missing/);
  });

  it('resolveOrder: включённый с выключенной зависимостью → ошибка', () => {
    const r = new ComponentRegistry();
    r.register(stub('a'));
    r.register(stub('b', ['a']));
    // a зарегистрирован, но не включён
    r.setEnabled('b', true);
    expect(() => r.resolveOrder()).toThrow();
  });

  it('resolveOrder: цикл → ошибка', () => {
    const r = new ComponentRegistry();
    r.register(stub('a', ['b']));
    r.register(stub('b', ['a']));
    r.setEnabled('a', true);
    r.setEnabled('b', true);
    expect(() => r.resolveOrder()).toThrow(/цикл/i);
  });
});
