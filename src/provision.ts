/**
 * provision — деплой-opt-in ядро (требование владельца «при развёртывании
 * выбираем ставить модуль»). Разворачиватель контура зовёт это, чтобы:
 *   1) записать выбор «ставить privacy или нет» в .env (блок PRIVACY_*);
 *   2) заранее разложить активный профиль в подписываемый ConfigStore, чтобы модуль
 *      поднялся уже сконфигурированным (bootstrap читает store как источник истины).
 *
 * Чистое ядро (renderPrivacyEnv/upsertEnvBlock/buildStoredConfig) не трогает диск —
 * тестируется без ФС. provision() пишет файлы через инъектируемый io (дефолт — fs).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { BUILTIN_PROFILES } from './profiles';
import type { StoredConfig } from './types';

export interface ProvisionChoice {
  /** true → PRIVACY_MODULE=on; false → off (блок остаётся, флаг снят). */
  enable: boolean;
  /** id профиля: 'base' | 'geo' | 'legal'. */
  profile: string;
  /** Порт loopback-backend (0 = эфемерный). */
  port?: number;
  host?: string;
  /** Команда Python-сайдкара. Пусто → сайдкар absent. */
  sidecarCmd?: string;
}

const BEGIN = '# >>> privacy (managed by scripts/privacy-provision.ts) >>>';
const END = '# <<< privacy <<<';

/** Рендер управляемого блока PRIVACY_* env. Ключи — только те, что реально читаются. */
export function renderPrivacyEnv(c: ProvisionChoice): string {
  const lines = [
    BEGIN,
    `PRIVACY_MODULE=${c.enable ? 'on' : 'off'}`,
    `PRIVACY_PROFILE=${c.profile}`,
    `PRIVACY_BACKEND_HOST=${c.host ?? '127.0.0.1'}`,
    `PRIVACY_BACKEND_PORT=${c.port ?? 7090}`,
    `PRIVACY_SIDECAR_CMD=${c.sidecarCmd ?? ''}`,
    END,
  ];
  return lines.join('\n');
}

/**
 * Вставляет/заменяет управляемый блок в содержимом .env.
 * Идемпотентно: повторный provision переписывает блок, не плодя дубли.
 */
export function upsertEnvBlock(existing: string, block: string): string {
  const beginIdx = existing.indexOf(BEGIN);
  if (beginIdx === -1) {
    const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
    const lead = existing.length ? '\n' : '';
    return existing + sep + lead + block + '\n';
  }
  const endIdx = existing.indexOf(END, beginIdx);
  const tail = endIdx === -1 ? existing.length : endIdx + END.length;
  return existing.slice(0, beginIdx) + block + existing.slice(tail);
}

/**
 * Раскладывает встроенный профиль в StoredConfig: включённые компоненты + их конфиг.
 * Неизвестный профиль → бросает (деплой должен упасть явно, а не молча взять base).
 */
export function buildStoredConfig(profileId: string): StoredConfig {
  const profile = BUILTIN_PROFILES.find((p) => p.id === profileId);
  if (!profile) {
    throw new Error(
      `Неизвестный профиль "${profileId}". Доступны: ${BUILTIN_PROFILES.map((p) => p.id).join(', ')}`,
    );
  }
  const components: StoredConfig['components'] = {};
  for (const [id, entry] of Object.entries(profile.components)) {
    components[id] = { enabled: entry.enabled, config: entry.config ?? {} };
  }
  return { activeProfile: profile.id, components };
}

export interface ProvisionIo {
  read: (path: string) => string;
  write: (path: string, data: string) => void;
  exists: (path: string) => boolean;
}

const fsIo: ProvisionIo = {
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, d) => writeFileSync(p, d, 'utf8'),
  exists: (p) => existsSync(p),
};

export interface ProvisionOpts extends ProvisionChoice {
  /** Путь к .env развёрнутого контура. */
  envPath: string;
  /** Путь к ConfigStore JSON (клиентская сторона). */
  storePath: string;
  io?: ProvisionIo;
}

export interface ProvisionResult {
  envPath: string;
  storePath: string;
  enabled: boolean;
  profile: string;
  /** Компоненты профиля, включённые в store. */
  enabledComponents: string[];
  summary: string;
}

/**
 * Применяет выбор «ставить privacy» к развёрнутому контуру: патчит .env и пишет store.
 * Даже при enable=false store с профилем пишется — чтобы включение позже было
 * одним флагом без повторного provision.
 */
export function provision(opts: ProvisionOpts): ProvisionResult {
  const io = opts.io ?? fsIo;
  const choice: ProvisionChoice = {
    enable: opts.enable,
    profile: opts.profile,
    port: opts.port,
    host: opts.host,
    sidecarCmd: opts.sidecarCmd,
  };

  // 1) store — валидирует профиль (бросит на неизвестном) ДО записи env
  const stored = buildStoredConfig(opts.profile);
  io.write(opts.storePath, JSON.stringify(stored, null, 2));

  // 2) .env — вставить/заменить управляемый блок
  const existing = io.exists(opts.envPath) ? io.read(opts.envPath) : '';
  io.write(opts.envPath, upsertEnvBlock(existing, renderPrivacyEnv(choice)));

  const enabledComponents = Object.entries(stored.components)
    .filter(([, e]) => e.enabled)
    .map(([id]) => id);

  const summary =
    `privacy ${opts.enable ? 'ВКЛ' : 'выкл'} · профиль "${opts.profile}" · ` +
    `компоненты: ${enabledComponents.join(', ') || '—'} · ` +
    `.env → ${opts.envPath} · store → ${opts.storePath}`;

  return {
    envPath: opts.envPath,
    storePath: opts.storePath,
    enabled: opts.enable,
    profile: opts.profile,
    enabledComponents,
    summary,
  };
}
