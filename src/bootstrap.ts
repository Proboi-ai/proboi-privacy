/**
 * bootstrapPrivacy — санкционированная точка входа деплой-opt-in обвязки.
 *
 * Инвариант изоляции: ЕДИНСТВЕННЫЙ разрешённый мост между хостом (раннер) и
 * модулем приватности. Хост зовёт bootstrapPrivacy() один раз при старте; если
 * PRIVACY_MODULE !== 'on' — возвращается ИНЕРТНЫЙ handle: ничего не собирается,
 * не спавнится, не слушает порт. Модуль полностью инертен по умолчанию.
 *
 * При PRIVACY_MODULE=on выполняется ПОЛНАЯ сборка конструктора, которой раньше не
 * было нигде (createPrivacyModule оставлял реестр пустым):
 *   keys(getKek) → envelope(kek) · audit · geo-mask(geoVault) · text-deid(tokenVault)
 *   → регистрация в реестре → применение активного профиля → старт сайдкара
 *   (если задан PRIVACY_SIDECAR_CMD) и loopback-backend.
 *
 * Всё остаётся на КЛИЕНТЕ (zero-knowledge): vault, ключи, конфиг, аудит-цепь
 * не уходят наружу. Backend слушает только 127.0.0.1.
 */

import { dirname } from 'node:path';
import { ComponentRegistry } from './registry';
import { EgressPipeline } from './pipeline';
import { PrivacyBackend } from './backend';
import { SidecarManager } from './sidecar';
import { ConfigStore, fileStore, memoryStore } from './config-store';
import { BUILTIN_PROFILES } from './profiles';
import {
  createEnvelopeComponent,
  createKeysComponent,
  createAuditComponent,
  createGeoMaskComponent,
  createTextDeidComponent,
  type KeysComponent,
} from './components';
import { GeoVault } from './geo/vault';
import { TokenVault } from './vault';
import type { AuditEvent } from './types';

/** Собранный (активный) модуль приватности — присутствует только при enabled. */
export interface AssembledPrivacy {
  registry: ComponentRegistry;
  pipeline: EgressPipeline;
  backend: PrivacyBackend;
  sidecar: SidecarManager;
  store: ConfigStore;
  keys: KeysComponent;
  vaults: { token: TokenVault; geo: GeoVault };
}

/** Результат bootstrap: инертный (enabled=false) либо собранный модуль. */
export interface PrivacyHandle {
  enabled: boolean;
  /** Порт loopback-backend (только если backend запущен). */
  port?: number;
  module?: AssembledPrivacy;
  /** Идемпотентная остановка: backend + сайдкар. Инертный handle — no-op. */
  stop(): Promise<void>;
}

export interface BootstrapOpts {
  /** Источник env (для тестов). Дефолт — process.env. */
  env?: Record<string, string | undefined>;
  /** Готовый store (тесты). Иначе — fileStore(storePath) или in-memory. */
  store?: ConfigStore;
  /** Путь к подписанному ConfigStore. Пусто → in-memory. */
  storePath?: string;
  /**
   * Директория ДОЛГОВЕЧНОГО хранения защищённого KEK (`<keyDir>/kek.dpapi`).
   * Дефолт (если не задан): env.PRIVACY_KEY_DIR, иначе dirname(storePath). Без обоих —
   * KEK остаётся эфемерным (генерируется заново на каждый bootstrap — прежнее поведение).
   */
  keyDir?: string;
  /**
   * Путь к keyfile с KEK-passphrase — Linux-путь хранения вместо DPAPI.
   * Дефолт: env.PRIVACY_KEK_KEYFILE. Если задан (опцией ИЛИ env) — используется вместо DPAPI
   * на любой платформе. Без него поведение прежнее (DPAPI на Windows / fail-closed иначе).
   */
  keyfilePath?: string;
  /** Команда сайдкара (тесты). Иначе берётся из PRIVACY_SIDECAR_CMD. */
  sidecarCmd?: string[];
  /** Стартовать ли loopback-backend. Дефолт true. */
  startBackend?: boolean;
  now?: () => number;
}

/** Инертный handle: модуль выключен, ничего не создано. */
function inert(): PrivacyHandle {
  return { enabled: false, async stop() {} };
}

export async function bootstrapPrivacy(opts: BootstrapOpts = {}): Promise<PrivacyHandle> {
  const env = opts.env ?? process.env;

  // Главный рубильник. Дефолт off → полная инертность.
  if ((env.PRIVACY_MODULE ?? 'off') !== 'on') return inert();

  const now = opts.now ?? (() => Date.now());

  // --- Сейфы (только на клиенте, zero-knowledge) ---
  const tokenVault = new TokenVault();
  const geoVault = new GeoVault();

  // --- Сайдкар. Нет команды → 'absent', upgrade-компоненты, зависящие от него, fail-closed. ---
  const sidecar = new SidecarManager(opts.sidecarCmd);
  await sidecar.start(); // идемпотентно; absent без команды

  // --- Компоненты конструктора ---
  // Долговечный KEK: keyDir явный → env.PRIVACY_KEY_DIR → рядом со storePath.
  // Ни один не задан → createKeysComponent сам падает обратно на эфемерный KEK.
  const keyDir = opts.keyDir ?? env.PRIVACY_KEY_DIR ?? (opts.storePath ? dirname(opts.storePath) : undefined);
  const keyfilePath = opts.keyfilePath ?? env.PRIVACY_KEK_KEYFILE;
  const keys = createKeysComponent({ keyDir, keyfilePath });
  const kek = await keys.getKek();
  const envelope = createEnvelopeComponent(kek);
  const audit = createAuditComponent({ now });
  const geoMask = createGeoMaskComponent(geoVault);
  const textDeid = createTextDeidComponent(tokenVault, { sidecar });

  const registry = new ComponentRegistry();
  for (const c of [keys, envelope, audit, geoMask, textDeid]) registry.register(c);

  // --- Store: файловый (прод) либо in-memory ---
  const store =
    opts.store ??
    new ConfigStore(opts.storePath ? fileStore(opts.storePath) : memoryStore());

  // --- Backend (loopback) ---
  const backend = new PrivacyBackend(registry, store, sidecar);

  // --- Конвейер egress: аудит → backend, cfg → store (профиль-зависимый) ---
  const pipeline = new EgressPipeline(registry, {
    now,
    audit: (ev: Omit<AuditEvent, 'seq'>) => backend.pushAudit(ev),
    configFor: (id) => store.get().components[id]?.config ?? {},
  });

  // --- Активный профиль. Store — единый источник истины (enabled + config).
  //     Persisted store (provision/оператор) авторитетен; свежий — засевается из
  //     env-профиля, чтобы конфиг компонентов реально дошёл до конвейера. ---
  const persisted = store.get();
  const hasPersisted = Object.keys(persisted.components).length > 0;
  if (hasPersisted) {
    for (const [id, entry] of Object.entries(persisted.components)) {
      if (registry.has(id)) registry.setEnabled(id, entry.enabled);
    }
  } else {
    const profileId = env.PRIVACY_PROFILE ?? persisted.activeProfile ?? 'base';
    const profile =
      BUILTIN_PROFILES.find((p) => p.id === profileId) ?? BUILTIN_PROFILES[0];
    for (const [id, entry] of Object.entries(profile.components)) {
      if (!registry.has(id)) continue; // напр. scan-redact ещё не построен
      registry.setEnabled(id, entry.enabled);
      const config = { ...(entry.config ?? {}) };
      if (id === 'text-deid') {
        if (env.PRIVACY_HIDE_MODE) config.hideMode = env.PRIVACY_HIDE_MODE;
        if (env.PRIVACY_MORPH) config.morph = env.PRIVACY_MORPH;
        if (env.PRIVACY_NER_ENGINE) config.nerEngine = env.PRIVACY_NER_ENGINE;
        if (env.PRIVACY_VERTICAL) {
          delete config.entities;
          config.vertical = env.PRIVACY_VERTICAL;
        }
      }
      store.setComponent(id, { enabled: entry.enabled, config });
    }
    store.setActiveProfile(profile.id);
  }

  // hot-reload: store → registry
  store.onChange((cfg) => {
    for (const [id, entry] of Object.entries(cfg.components)) {
      if (registry.has(id)) registry.setEnabled(id, entry.enabled);
    }
  });

  const module: AssembledPrivacy = {
    registry,
    pipeline,
    backend,
    sidecar,
    store,
    keys,
    vaults: { token: tokenVault, geo: geoVault },
  };

  let port: number | undefined;
  if (opts.startBackend !== false) port = backend.start();

  let stopped = false;
  return {
    enabled: true,
    port,
    module,
    async stop() {
      if (stopped) return;
      stopped = true;
      backend.stop();
      await sidecar.stop();
    },
  };
}
