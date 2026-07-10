/**
 * EgressPipeline: прогоняет payload через включённые компоненты в топологическом порядке.
 * Fail-closed: включённый, но недоступный компонент → PrivacyBlockedError.
 */

import type { Payload, AuditEvent } from './types';
import { PrivacyBlockedError } from './types';
import type { ComponentRegistry } from './registry';

interface PipelineOpts {
  failClosed?: boolean;             // дефолт true
  now?: () => number;
  audit?: (ev: Omit<AuditEvent, 'seq'>) => void;
  /** Конфиг компонента из ConfigStore (профиль-зависимый). Пусто → {}. */
  configFor?: (id: string) => Record<string, unknown>;
}

export class EgressPipeline {
  private reg: ComponentRegistry;
  private failClosed: boolean;
  private now: () => number;
  private auditFn: (ev: Omit<AuditEvent, 'seq'>) => void;
  private configFor: (id: string) => Record<string, unknown>;

  constructor(registry: ComponentRegistry, opts: PipelineOpts = {}) {
    this.reg = registry;
    this.failClosed = opts.failClosed ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.auditFn = opts.audit ?? (() => {});
    this.configFor = opts.configFor ?? (() => ({}));
  }

  /** Прямой проход (beforeEgress): де-ид перед отправкой в облако */
  async runEgress(p: Payload): Promise<Payload> {
    const order = this.reg.resolveOrder();
    let cur = p;
    for (const c of order) {
      if (!c.beforeEgress) continue;
      // Fail-closed: если available() вернул false/rejected — блокируем
      if (c.available) {
        const ok = await Promise.resolve(c.available()).catch(() => false);
        if (!ok) throw new PrivacyBlockedError(c.id);
      }
      const ctx = this.makeCtx(c.id, this.reg.get(c.id)!);
      cur = await c.beforeEgress(cur, ctx);
      this.auditFn({ ts: this.now(), component: c.id, action: 'beforeEgress', detail: { kind: cur.kind } });
    }
    return cur;
  }

  /** Обратный проход (afterResponse): ре-идентификация в обратном порядке */
  async runResponse(p: Payload): Promise<Payload> {
    const order = [...this.reg.resolveOrder()].reverse();
    let cur = p;
    for (const c of order) {
      if (!c.afterResponse) continue;
      if (c.available) {
        const ok = await Promise.resolve(c.available()).catch(() => false);
        if (!ok) throw new PrivacyBlockedError(c.id);
      }
      const ctx = this.makeCtx(c.id, this.reg.get(c.id)!);
      cur = await c.afterResponse(cur, ctx);
      this.auditFn({ ts: this.now(), component: c.id, action: 'afterResponse', detail: { kind: cur.kind } });
    }
    return cur;
  }

  /** Шифрование при записи (atRest) */
  async runAtRest(bytes: Uint8Array): Promise<Uint8Array> {
    const order = this.reg.resolveOrder();
    let cur = bytes;
    for (const c of order) {
      if (!c.atRest) continue;
      if (c.available) {
        const ok = await Promise.resolve(c.available()).catch(() => false);
        if (!ok) throw new PrivacyBlockedError(c.id);
      }
      const ctx = this.makeCtx(c.id, this.reg.get(c.id)!);
      cur = await c.atRest(cur, ctx);
      this.auditFn({ ts: this.now(), component: c.id, action: 'atRest', detail: { bytes: cur.length } });
    }
    return cur;
  }

  private makeCtx(id: string, _c: unknown) {
    // cfg из ConfigStore (профиль-зависимый); дефолт — пустой объект
    return {
      cfg: this.configFor(id),
      audit: (ev: Omit<AuditEvent, 'seq'>) => this.auditFn(ev),
      now: this.now,
    };
  }
}
