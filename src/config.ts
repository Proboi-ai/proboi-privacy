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

// Уровни 2–3 надёжного возврата оригиналов (Трек C): '1' — вкл, иначе выкл.
// Дефолт ВЫКЛ — инвариант «без флагов поведение как раньше»; профиль on-prem включает сам.
// Читается по месту (egress-gate), а не отсюда: тесты меняют env в рантайме.
export const PRIVACY_RESTORE_FUZZY = process.env.PRIVACY_RESTORE_FUZZY ?? '0';
