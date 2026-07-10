import { describe, it, expect } from 'bun:test';
import { ComponentRegistry } from './registry';
import { EgressPipeline } from './pipeline';
import { PrivacyBlockedError } from './types';
import type { PrivacyComponent, Payload, ComponentContext } from './types';

function makePayload(text = 'hello'): Payload {
  return { kind: 'text', text, meta: {} };
}

function stubComp(
  id: string,
  opts: {
    beforeEgress?: (p: Payload) => Payload;
    afterResponse?: (p: Payload) => Payload;
    available?: () => boolean;
    requires?: string[];
  } = {},
): PrivacyComponent {
  return {
    id,
    tier: 'T0',
    runtime: 'ts-spine',
    configSchema: {},
    requires: opts.requires,
    beforeEgress: opts.beforeEgress
      ? (p, _ctx) => opts.beforeEgress!(p)
      : undefined,
    afterResponse: opts.afterResponse
      ? (p, _ctx) => opts.afterResponse!(p)
      : undefined,
    available: opts.available,
  };
}

describe('EgressPipeline', () => {
  it('runEgress: порядок beforeEgress соблюдается', async () => {
    const order: string[] = [];
    const r = new ComponentRegistry();
    r.register(stubComp('a', { beforeEgress: (p) => { order.push('a'); return p; } }));
    r.register(stubComp('b', { beforeEgress: (p) => { order.push('b'); return p; }, requires: ['a'] }));
    r.setEnabled('a', true);
    r.setEnabled('b', true);
    const pipe = new EgressPipeline(r);
    await pipe.runEgress(makePayload());
    expect(order).toEqual(['a', 'b']);
  });

  it('runResponse: afterResponse в обратном порядке', async () => {
    const order: string[] = [];
    const r = new ComponentRegistry();
    r.register(stubComp('a', { afterResponse: (p) => { order.push('a'); return p; } }));
    r.register(stubComp('b', { afterResponse: (p) => { order.push('b'); return p; }, requires: ['a'] }));
    r.setEnabled('a', true);
    r.setEnabled('b', true);
    const pipe = new EgressPipeline(r);
    await pipe.runResponse(makePayload());
    // b был добавлен после a, значит обратный порядок = b, a
    expect(order).toEqual(['b', 'a']);
  });

  it('fail-closed: включённый, недоступный компонент → PrivacyBlockedError', async () => {
    const r = new ComponentRegistry();
    r.register(stubComp('x', {
      beforeEgress: (p) => p,
      available: () => false,
    }));
    r.setEnabled('x', true);
    const pipe = new EgressPipeline(r, { failClosed: true });
    await expect(pipe.runEgress(makePayload())).rejects.toBeInstanceOf(PrivacyBlockedError);
  });

  it('выключенный компонент пропускается', async () => {
    const called: string[] = [];
    const r = new ComponentRegistry();
    r.register(stubComp('a', { beforeEgress: (p) => { called.push('a'); return p; } }));
    // a не включаем
    const pipe = new EgressPipeline(r);
    await pipe.runEgress(makePayload());
    expect(called).toHaveLength(0);
  });

  it('audit вызывается для каждого пройденного компонента', async () => {
    const events: string[] = [];
    const r = new ComponentRegistry();
    r.register(stubComp('a', { beforeEgress: (p) => p }));
    r.setEnabled('a', true);
    const pipe = new EgressPipeline(r, { audit: (ev) => events.push(ev.component) });
    await pipe.runEgress(makePayload());
    expect(events).toContain('a');
  });

  it('available() = true → компонент прогоняется', async () => {
    const r = new ComponentRegistry();
    let ran = false;
    r.register(stubComp('a', {
      beforeEgress: (p) => { ran = true; return p; },
      available: () => true,
    }));
    r.setEnabled('a', true);
    const pipe = new EgressPipeline(r);
    await pipe.runEgress(makePayload());
    expect(ran).toBe(true);
  });

  it('компонент без beforeEgress не мешает пайплайну', async () => {
    const r = new ComponentRegistry();
    // только atRest, без beforeEgress
    r.register({ id: 'noegress', tier: 'T0', runtime: 'ts-spine', configSchema: {}, atRest: async (b) => b });
    r.setEnabled('noegress', true);
    const pipe = new EgressPipeline(r);
    const out = await pipe.runEgress(makePayload());
    expect(out.text).toBe('hello');
  });
});
