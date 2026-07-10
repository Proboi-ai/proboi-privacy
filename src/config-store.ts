/**
 * ConfigStore — хранит активный профиль и конфиги компонентов.
 * По умолчанию без крипты. Опциональные hooks { envelope, audit } — шифрование + аудит
 *   при изменениях. Если hooks не переданы — поведение как без крипты (обратная совместимость).
 *
 * Инъектируемая персистенция: { load, save } → позволяет in-memory в тестах.
 * Фабрика fileStore(path) для прода — читает/пишет JSON.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { StoredConfig } from './types';

type Persistence = {
  load: () => StoredConfig | null;
  save: (c: StoredConfig) => void;
};

/**
 * Хуки: envelope (шифрование блоба) + audit (запись в аудит-цепочку).
 * onEncrypted вызывается с зашифрованным блобом — для async-персистенции или тестов.
 */
export interface StoreHooks {
  envelope?: {
    encryptBytes(plain: Uint8Array): Promise<Uint8Array>;
  };
  audit?: {
    append(entry: string): void;
  };
  /** Получить зашифрованный блоб после сохранения (необязательно). */
  onEncrypted?: (encrypted: Uint8Array) => void;
}

const DEFAULT_CONFIG: StoredConfig = {
  activeProfile: 'base',
  components: {},
};

export class ConfigStore {
  private data: StoredConfig;
  private persistence: Persistence;
  private changeListeners: Array<(c: StoredConfig) => void> = [];
  private hooks?: StoreHooks;

  constructor(persistence: Persistence, hooks?: StoreHooks) {
    this.persistence = persistence;
    this.hooks = hooks;
    this.data = persistence.load() ?? { ...DEFAULT_CONFIG, components: {} };
  }

  get(): StoredConfig {
    return this.data;
  }

  setActiveProfile(id: string): void {
    this.data = { ...this.data, activeProfile: id };
    this.flush();
  }

  setComponent(id: string, opts: { enabled?: boolean; config?: Record<string, unknown> }): void {
    const prev = this.data.components[id] ?? { enabled: false, config: {} };
    this.data = {
      ...this.data,
      components: {
        ...this.data.components,
        [id]: {
          enabled: opts.enabled ?? prev.enabled,
          config: opts.config ?? prev.config,
        },
      },
    };
    this.flush();
  }

  /** Подписка на изменения (hot-reload, аудит) */
  onChange(cb: (c: StoredConfig) => void): void {
    this.changeListeners.push(cb);
  }

  private flush(): void {
    this.persistence.save(this.data);
    // аудит каждого изменения
    this.hooks?.audit?.append(JSON.stringify(this.data));
    // fire-and-forget шифрование блоба (если envelope подключён)
    if (this.hooks?.envelope) {
      const bytes = new TextEncoder().encode(JSON.stringify(this.data));
      this.hooks.envelope.encryptBytes(bytes)
        .then(enc => this.hooks?.onEncrypted?.(enc))
        .catch(() => {}); // не блокирует sync-путь
    }
    for (const cb of this.changeListeners) cb(this.data);
  }
}

/** Фабрика: файловое хранилище JSON для прода */
export function fileStore(path: string): Persistence {
  return {
    load: () => {
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as StoredConfig;
      } catch {
        return null;
      }
    },
    save: (c) => writeFileSync(path, JSON.stringify(c, null, 2), 'utf8'),
  };
}

/** Фабрика: in-memory (для тестов) */
export function memoryStore(initial?: StoredConfig): Persistence {
  let state: StoredConfig | null = initial ?? null;
  return {
    load: () => state,
    save: (c) => { state = c; },
  };
}
