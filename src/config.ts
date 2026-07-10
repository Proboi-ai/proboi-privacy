/**
 * Локальные env-флаги privacy-модуля.
 * Не импортировать конфиг хост-приложения — модуль должен быть изолированным островом.
 */

// Главный рубильник: 'on' | 'off' (дефолт off — модуль инертен)
export const PRIVACY_MODULE = process.env.PRIVACY_MODULE ?? 'off';

// Loopback API-сервер
export const PRIVACY_BACKEND_HOST = process.env.PRIVACY_BACKEND_HOST ?? '127.0.0.1';
// 0 = эфемерный порт (удобно в тестах); в проде задать явно (напр. 7090)
export const PRIVACY_BACKEND_PORT = parseInt(process.env.PRIVACY_BACKEND_PORT ?? '0', 10);

// Активный профиль при старте: 'base' | 'geo' | 'legal'
export const PRIVACY_PROFILE = process.env.PRIVACY_PROFILE ?? 'base';

// URL Python-сайдкара (пусто → sidecar 'absent')
export const PRIVACY_SIDECAR_URL = process.env.PRIVACY_SIDECAR_URL ?? '';

// Команда запуска сайдкара: "python sidecar.py" и т.п. Пусто → 'absent'.
// Общение по stdin/stdout JSON-newline (Bun.spawn, НЕ Worker).
export const PRIVACY_SIDECAR_CMD = process.env.PRIVACY_SIDECAR_CMD ?? '';
