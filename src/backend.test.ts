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
  });

  it('POST /profiles/unknown/apply → 404', async () => {
    const res = await fetch(`${baseUrl}/profiles/nonexistent/apply`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
