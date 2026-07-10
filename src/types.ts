/**
 * Контракты privacy-модуля.
 * Базовый уровень без крипты; шифрование, реальная де-ид и сайдкар добавляются поверх.
 */

// Уровень доверия (T0=локальный/воздушный зазор ... T3=публичный облак)
export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

// Рантайм компонента: spine=TypeScript внутри процесса, sidecar=внешний Python
export type Runtime = 'ts-spine' | 'py-sidecar';

// Единица данных, проходящая через пайплайн
export interface Payload {
  kind: string;
  text?: string;
  bytes?: Uint8Array;
  meta: Record<string, unknown>;
}

// Запись аудита (seq присваивает хранилище)
export interface AuditEvent {
  seq?: number;
  ts: number;
  component: string;
  action: string;
  detail: Record<string, unknown>;
}

// JSON Schema — пока непрозрачный; валидатор добавится позже
export type JSONSchema = Record<string, unknown>;

// Контекст, который pipeline передаёт каждому компоненту
export interface ComponentContext {
  cfg: Record<string, unknown>;
  audit(ev: Omit<AuditEvent, 'seq'>): void;
  now(): number;
}

// Интерфейс privacy-компонента
export interface PrivacyComponent {
  id: string;
  tier: Tier;
  runtime: Runtime;
  requires?: string[];        // id компонентов, которые должны быть включены до этого
  configSchema: JSONSchema;

  // Де-ид/маска ДО отправки в облако
  beforeEgress?(p: Payload, ctx: ComponentContext): Payload | Promise<Payload>;
  // Ре-идентификация после ответа
  afterResponse?(p: Payload, ctx: ComponentContext): Payload | Promise<Payload>;
  // Шифр при записи на диск
  atRest?(bytes: Uint8Array, ctx: ComponentContext): Uint8Array | Promise<Uint8Array>;
  // Для fail-closed: сайдкар жив?
  available?(): boolean | Promise<boolean>;
}

// Пресет-профиль: набор id → {enabled, config}
export interface Profile {
  id: string;
  label: string;
  components: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
}

// Структура, хранимая в config-store
export interface StoredConfig {
  activeProfile: string;
  components: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
}

// Компонент включён, но недоступен (fail-closed)
export class PrivacyBlockedError extends Error {
  constructor(componentId: string) {
    super(`Privacy component "${componentId}" is enabled but not available (fail-closed)`);
    this.name = 'PrivacyBlockedError';
  }
}
