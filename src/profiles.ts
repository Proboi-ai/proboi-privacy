/**
 * Пресеты профилей (только данные — компоненты подключаются отдельно).
 * BASE: минимальный аудит + конверт.
 * GEO:  де-ид координат/ФИО/ORG + маска геоданных + scan-redact.
 * LEGAL: де-ид ФИО/ORG/дат/номеров дел + scan-redact; гео-маска выкл.
 *
 * scan-redact = fail-closed ЗАСЛОН, не OCR: скан без текстового слоя
 * блокируется целиком (чистить содержимое картинки пока нечем) — см.
 * components/scan-redact.ts.
 *
 * STANDARD/STRICT: универсальные уровни де-ид для любого документа, без гео-специфики.
 * STANDARD — лёгкий (ФИО+организации). STRICT — максимум того, что реально детектит
 * deid/detect.ts (PER/ORG/DATE/CASE/COORD) + redact сканов. Суммы/адреса/телефоны
 * НЕ включены — детектора для них в deid/detect.ts нет, «не выдумывать детекторы».
 */

import type { Profile } from './types';
import type { ComponentRegistry } from './registry';

export const BASE: Profile = {
  id: 'base',
  label: 'Базовый (только аудит)',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
  },
};

export const GEO: Profile = {
  id: 'geo',
  label: 'Геологические данные',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { vertical: 'geo' } },
    'scan-redact': { enabled: true },
    'geo-mask': { enabled: true },
  },
};

export const LEGAL: Profile = {
  id: 'legal',
  label: 'Юридические документы',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { vertical: 'legal' } },
    'scan-redact': { enabled: true },
    'geo-mask': { enabled: false },
  },
};

export const COMMON: Profile = {
  id: 'common',
  label: 'Общий профиль',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { vertical: 'common' } },
  },
};

export const FINANCE: Profile = {
  id: 'finance',
  label: 'Финансы и бухгалтерия',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { vertical: 'finance' } },
    'scan-redact': { enabled: true },
  },
};

export const MEDICAL: Profile = {
  id: 'medical',
  label: 'Медицинские документы',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { vertical: 'medical' } },
    'scan-redact': { enabled: true },
  },
};

export const HR: Profile = {
  id: 'hr',
  label: 'Кадровые документы',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { vertical: 'hr' } },
    'scan-redact': { enabled: true },
  },
};

export const STANDARD: Profile = {
  id: 'standard',
  label: 'Стандартный (де-ид ФИО и организаций)',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { entities: ['PER', 'ORG'] } },
  },
};

export const STRICT: Profile = {
  id: 'strict',
  label: 'Строгий (максимум де-ид: ФИО, организации, даты, номера дел, координаты)',
  components: {
    'audit-logger': { enabled: true },
    'envelope': { enabled: true },
    'key-store': { enabled: true },
    'text-deid': { enabled: true, config: { entities: ['PER', 'ORG', 'DATE', 'CASE', 'COORD'] } },
    'scan-redact': { enabled: true },
    'geo-mask': { enabled: false },
  },
};

/** Все встроенные профили */
export const BUILTIN_PROFILES: Profile[] = [
  BASE,
  COMMON,
  GEO,
  LEGAL,
  FINANCE,
  MEDICAL,
  HR,
  STANDARD,
  STRICT,
];

/**
 * Применяет профиль к реестру: включает/выключает зарегистрированные компоненты.
 * Неизвестный id — это невыполненное обещание профиля: громко предупреждаем
 * (до 03.08.2026 'scan-redact' обещался всеми строгими профилями, не существуя
 * в коде вообще, и тишина скрывала это месяц). Возвращает список пропущенных.
 */
export function applyProfile(
  registry: ComponentRegistry,
  profile: Profile,
): string[] {
  const skipped: string[] = [];
  for (const [id, entry] of Object.entries(profile.components)) {
    if (!registry.has(id)) {
      skipped.push(id);
      if (entry.enabled) {
        console.warn(
          `[privacy] профиль "${profile.id}" обещает компонент "${id}", которого нет в реестре — защита НЕ активна`,
        );
      }
      continue;
    }
    registry.setEnabled(id, entry.enabled);
  }
  return skipped;
}
