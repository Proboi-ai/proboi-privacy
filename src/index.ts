/**
 * Публичный API privacy-модуля.
 * ВАЖНО: этот файл не должен напрямую тянуться из основных точек входа хост-приложения
 * (главный entry point и раннер) — инвариант изоляции.
 *
 * Использование:
 *   import { createPrivacyModule } from './index';
 *   const mod = createPrivacyModule({ store });
 *   mod.backend.start();
 */

import { ComponentRegistry } from './registry';
import { EgressPipeline } from './pipeline';
import { PrivacyBackend } from './backend';
import { SidecarManager } from './sidecar';
import type { ConfigStore } from './config-store';
import type { AuditEvent } from './types';

interface Deps {
  store: ConfigStore;
  now?: () => number;
}

export interface PrivacyModule {
  registry: ComponentRegistry;
  pipeline: EgressPipeline;
  backend: PrivacyBackend;
  sidecar: SidecarManager;
}

export function createPrivacyModule(deps: Deps): PrivacyModule {
  const { store, now } = deps;

  const auditBuffer: AuditEvent[] = [];
  let seq = 0;
  function audit(ev: Omit<AuditEvent, 'seq'>) {
    auditBuffer.push({ ...ev, seq: ++seq });
  }

  const registry = new ComponentRegistry();
  const pipeline = new EgressPipeline(registry, { now, audit });
  const sidecar = new SidecarManager();
  const backend = new PrivacyBackend(registry, store, sidecar);

  // hot-reload: синхронизировать store → registry при изменениях
  store.onChange((cfg) => {
    for (const [id, entry] of Object.entries(cfg.components)) {
      if (registry.has(id)) registry.setEnabled(id, entry.enabled);
    }
  });

  return { registry, pipeline, backend, sidecar };
}

// Реэкспорт типов и классов, которые могут понадобиться вызывающей стороне
export { ComponentRegistry } from './registry';
export { EgressPipeline } from './pipeline';
export { PrivacyBackend } from './backend';
export { SidecarManager } from './sidecar';
export { ConfigStore, memoryStore, fileStore } from './config-store';
export { BUILTIN_PROFILES, BASE, GEO, LEGAL, applyProfile } from './profiles';
export type {
  Tier,
  Runtime,
  Payload,
  AuditEvent,
  JSONSchema,
  ComponentContext,
  PrivacyComponent,
  Profile,
  StoredConfig,
} from './types';
export { PrivacyBlockedError } from './types';
