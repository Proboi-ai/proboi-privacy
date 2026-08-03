import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PrivacyBackend } from './backend';
import { ComponentRegistry } from './registry';
import { ConfigStore, memoryStore } from './config-store';
import { SidecarManager } from './sidecar';
import type { PrivacyComponent } from './types';

function stub(id: string): PrivacyComponent {
  return { id, tier: 'T0', runtime: 'ts-spine', configSchema: {} };
}

describe('PrivacyBackend', () => {
  let backend: PrivacyBackend;
  let registry: ComponentRegistry;
  let store: ConfigStore;
  let sidecar: SidecarManager;
  let baseUrl: string;

  beforeAll(() => {
    registry = new ComponentRegistry();
    registry.register(stub('audit-logger'));
    registry.register(stub('envelope'));
    registry.register(stub('geo-mask'));
    registry.register(stub('text-deid'));

    store = new ConfigStore(memoryStore());
    sidecar = new SidecarManager();
    backend = new PrivacyBackend(registry, store, sidecar);

    const port = backend.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => { backend.stop(); });

  it('GET /profiles → массив профилей с id', async () => {
    const res = await fetch(`${baseUrl}/profiles`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((p) => p.id === 'base')).toBe(true);
    expect(body.some((p) => p.id === 'geo')).toBe(true);
  });

  it('GET /components → список зарегистрированных компонентов', async () => {
    const res = await fetch(`${baseUrl}/components`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; enabled: boolean }>;
    expect(body.some(c => c.id === 'audit-logger')).toBe(true);
    expect(body.some(c => c.id === 'geo-mask')).toBe(true);
  });

  it('PATCH /components/:id → включает компонент', async () => {
    const res = await fetch(`${baseUrl}/components/audit-logger`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; enabled: boolean };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(registry.isEnabled('audit-logger')).toBe(true);
  });

  it('PATCH /components/:unknown → 404', async () => {
    const res = await fetch(`${baseUrl}/components/ghost`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /sidecar/health → {status}', async () => {
    const res = await fetch(`${baseUrl}/sidecar/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(['absent', 'healthy', 'down']).toContain(body.status);
  });

  it('GET /audit → массив (пустой при старте)', async () => {
    const res = await fetch(`${baseUrl}/audit`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /profiles/geo/apply → применяет профиль', async () => {
    const res = await fetch(`${baseUrl}/profiles/geo/apply`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skipped: string[] };
    expect(body.ok).toBe(true);
    // geo-mask зарегистрирован → не в skipped
    expect(body.skipped).not.toContain('geo-mask');
    expect(store.get().components['text-deid']?.config).toEqual({ vertical: 'geo' });
  });

  it('POST /profiles/medical/apply → переключает vertical в runtime config', async () => {
    const res = await fetch(`${baseUrl}/profiles/medical/apply`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(store.get().activeProfile).toBe('medical');
    expect(store.get().components['text-deid']?.config).toEqual({ vertical: 'medical' });
  });

  it('POST /profiles/unknown/apply → 404', async () => {
    const res = await fetch(`${baseUrl}/profiles/nonexistent/apply`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('non-loopback bind без сильного токена отказывается стартовать', () => {
    const external = new PrivacyBackend(registry, store, sidecar, { host: '0.0.0.0', port: 0, token: '' });
    expect(() => external.start()).toThrow(/non-loopback bind.*TOKEN/);
  });

  it('Bearer token защищает API, а loopback с токеном остаётся доступен авторизованному клиенту', async () => {
    const token = 'privacy-test-token-123456';
    const secured = new PrivacyBackend(registry, store, sidecar, { host: '127.0.0.1', port: 0, token });
    const url = `http://127.0.0.1:${secured.start()}`;
    try {
      expect((await fetch(`${url}/components`)).status).toBe(401);
      expect((await fetch(`${url}/components`, {
        headers: { authorization: `Bearer ${token}` },
      })).status).toBe(200);
    } finally {
      secured.stop();
    }
  });

  it('state-changing routes reject cross-origin requests before mutation', async () => {
    const token = 'privacy-test-token-123456';
    const isolatedRegistry = new ComponentRegistry();
    isolatedRegistry.register(stub('audit-logger'));
    const secured = new PrivacyBackend(
      isolatedRegistry,
      new ConfigStore(memoryStore()),
      sidecar,
      { host: '127.0.0.1', port: 0, token },
    );
    const url = `http://127.0.0.1:${secured.start()}`;
    try {
      const denied = await fetch(`${url}/components/audit-logger`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        body: JSON.stringify({ enabled: true }),
      });
      expect(denied.status).toBe(403);
      expect(isolatedRegistry.isEnabled('audit-logger')).toBe(false);

      const allowed = await fetch(`${url}/components/audit-logger`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          origin: url,
        },
        body: JSON.stringify({ enabled: true }),
      });
      expect(allowed.status).toBe(200);
      expect(isolatedRegistry.isEnabled('audit-logger')).toBe(true);
    } finally {
      secured.stop();
    }
  });
});
