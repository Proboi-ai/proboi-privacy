import { describe, it, expect } from 'bun:test';
import { ConfigStore, memoryStore } from './config-store';

describe('ConfigStore', () => {
  it('get() возвращает дефолтный конфиг при пустом хранилище', () => {
    const store = new ConfigStore(memoryStore());
    const cfg = store.get();
    expect(cfg.activeProfile).toBe('base');
    expect(cfg.components).toEqual({});
  });

  it('setActiveProfile → get() roundtrip', () => {
    const store = new ConfigStore(memoryStore());
    store.setActiveProfile('geo');
    expect(store.get().activeProfile).toBe('geo');
  });

  it('setComponent → get() roundtrip', () => {
    const store = new ConfigStore(memoryStore());
    store.setComponent('text-deid', { enabled: true, config: { entities: ['PER'] } });
    const c = store.get().components['text-deid'];
    expect(c.enabled).toBe(true);
    expect(c.config).toEqual({ entities: ['PER'] });
  });

  it('setComponent: обновление только enabled сохраняет config', () => {
    const store = new ConfigStore(memoryStore());
    store.setComponent('foo', { enabled: false, config: { x: 1 } });
    store.setComponent('foo', { enabled: true });
    const c = store.get().components['foo'];
    expect(c.enabled).toBe(true);
    expect(c.config).toEqual({ x: 1 });
  });

  it('onChange вызывается после каждого изменения', () => {
    const store = new ConfigStore(memoryStore());
    const calls: string[] = [];
    store.onChange((c) => calls.push(c.activeProfile));
    store.setActiveProfile('geo');
    store.setActiveProfile('legal');
    expect(calls).toEqual(['geo', 'legal']);
  });

  it('load из initial значения', () => {
    const initial = { activeProfile: 'legal', components: { foo: { enabled: true, config: {} } } };
    const store = new ConfigStore(memoryStore(initial));
    expect(store.get().activeProfile).toBe('legal');
    expect(store.get().components['foo'].enabled).toBe(true);
  });

  it('персистенция: изменение сохраняется в хранилище', () => {
    let saved: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new ConfigStore({ load: () => null, save: (c: any) => { saved = c; } });
    store.setActiveProfile('geo');
    expect((saved as { activeProfile: string }).activeProfile).toBe('geo');
  });
});
