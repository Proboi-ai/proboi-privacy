/**
 * PrivacyBackend — loopback HTTP API для управления модулем.
 * Слушает ТОЛЬКО на 127.0.0.1 (не 0.0.0.0).
 *
 * Пустой токен допустим только на loopback (dev/test). Внешний bind fail-closed.
 *
 * Роуты:
 *   GET  /profiles              → список пресетов
 *   POST /profiles/:id/apply    → применить профиль
 *   GET  /components            → состояние реестра
 *   PATCH /components/:id       → {enabled?, config?}
 *   GET  /sidecar/health        → {status}
 *   GET  /audit                 → последние записи из in-memory буфера
 *   GET  /                      → статика admin-mockup/dist (если есть) | 404
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { timingSafeEqual } from 'node:crypto';
import { PRIVACY_BACKEND_HOST, PRIVACY_BACKEND_PORT, PRIVACY_BACKEND_TOKEN } from './config';
import { BUILTIN_PROFILES, applyProfile } from './profiles';
import type { ComponentRegistry } from './registry';
import type { ConfigStore } from './config-store';
import type { SidecarManager } from './sidecar';
import type { AuditEvent } from './types';

const ADMIN_DIST = join(import.meta.dir, '..', '..', 'admin-mockup', 'dist');

export interface PrivacyBackendOptions {
  host?: string;
  port?: number;
  token?: string;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(actual.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export class PrivacyBackend {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private auditLog: AuditEvent[] = [];
  private seq = 0;

  constructor(
    private readonly registry: ComponentRegistry,
    private readonly store: ConfigStore,
    private readonly sidecar: SidecarManager,
    private readonly options: PrivacyBackendOptions = {},
  ) {}

  /** Добавить запись в in-memory аудит-лог */
  pushAudit(ev: Omit<AuditEvent, 'seq'>): void {
    this.auditLog.push({ ...ev, seq: ++this.seq });
    // Ограничиваем буфер: 1000 последних записей
    if (this.auditLog.length > 1000) this.auditLog.shift();
  }

  /** Запустить сервер; возвращает реальный порт (важно для port=0) */
  start(): number {
    const self = this;
    const host = this.options.host ?? PRIVACY_BACKEND_HOST;
    const port = this.options.port ?? PRIVACY_BACKEND_PORT;
    const token = this.options.token ?? PRIVACY_BACKEND_TOKEN;
    if (!isLoopbackHost(host) && token.length < 16) {
      throw new Error('Privacy Backend: non-loopback bind требует PRIVACY_BACKEND_TOKEN (минимум 16 символов)');
    }
    this.server = Bun.serve({
      hostname: host,
      port,
      async fetch(req) {
        return self.handle(req);
      },
    });
    return (this.server as { port: number }).port;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const token = this.options.token ?? PRIVACY_BACKEND_TOKEN;

    if (token && !tokenMatches(req.headers.get('authorization'), token)) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = req.headers.get('origin');
      const crossSite = req.headers.get('sec-fetch-site') === 'cross-site';
      if (crossSite || (origin !== null && origin !== url.origin)) {
        return json({ error: 'Forbidden origin' }, 403);
      }
    }

    // GET /profiles
    if (method === 'GET' && path === '/profiles') {
      return json(BUILTIN_PROFILES);
    }

    // POST /profiles/:id/apply
    const applyMatch = path.match(/^\/profiles\/([^/]+)\/apply$/);
    if (method === 'POST' && applyMatch) {
      const id = applyMatch[1];
      const profile = BUILTIN_PROFILES.find(p => p.id === id);
      if (!profile) return json({ error: 'Profile not found' }, 404);
      const skipped = applyProfile(this.registry, profile);
      for (const [componentId, entry] of Object.entries(profile.components)) {
        if (!this.registry.has(componentId)) continue;
        this.store.setComponent(componentId, {
          enabled: entry.enabled,
          config: { ...(entry.config ?? {}) },
        });
      }
      this.store.setActiveProfile(id);
      return json({ ok: true, skipped });
    }

    // GET /components
    if (method === 'GET' && path === '/components') {
      const list = this.registry.list().map(c => ({
        id: c.id,
        tier: c.tier,
        runtime: c.runtime,
        enabled: this.registry.isEnabled(c.id),
        requires: c.requires ?? [],
      }));
      return json(list);
    }

    // PATCH /components/:id
    const patchMatch = path.match(/^\/components\/([^/]+)$/);
    if (method === 'PATCH' && patchMatch) {
      const id = patchMatch[1];
      if (!this.registry.has(id)) return json({ error: 'Component not found' }, 404);
      let body: { enabled?: boolean; config?: Record<string, unknown> } = {};
      try { body = await req.json(); } catch { /* ignore empty body */ }
      if (typeof body.enabled === 'boolean') {
        this.registry.setEnabled(id, body.enabled);
        this.store.setComponent(id, { enabled: body.enabled, config: body.config });
      } else if (body.config !== undefined) {
        this.store.setComponent(id, { config: body.config });
      }
      return json({ ok: true, id, enabled: this.registry.isEnabled(id) });
    }

    // GET /sidecar/health
    if (method === 'GET' && path === '/sidecar/health') {
      const status = await this.sidecar.health();
      return json({ status, ...this.sidecar.healthDetails() });
    }

    // GET /audit
    if (method === 'GET' && path === '/audit') {
      // Сейчас возвращаем in-memory буфер.
      // TODO: крипто-цепь (HMAC-связанные записи).
      return json(this.auditLog);
    }

    // GET / → статика admin-mockup/dist (если папка есть)
    if (method === 'GET' && (path === '/' || path === '')) {
      if (existsSync(ADMIN_DIST)) {
        const indexPath = join(ADMIN_DIST, 'index.html');
        if (existsSync(indexPath)) {
          return new Response(Bun.file(indexPath));
        }
      }
      return new Response('Not Found', { status: 404 });
    }

    return json({ error: 'Not Found' }, 404);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
