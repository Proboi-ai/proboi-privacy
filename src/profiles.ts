/**
 * Пресеты профилей (только данные — компоненты подключаются отдельно).
 * BASE: минимальный аудит + конверт.
 * GEO:  де-ид координат/ФИО/ORG + маска геоданных + redact сканов.
 * LEGAL: де-ид ФИО/ORG/дат/номеров дел + redact сканов; гео-маска выкл.
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
    'text-deid': { enabled: true, config: { entities: ['COORD', 'PER', 'ORG', 'DATE'] } },
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
    'text-deid': { enabled: true, config: { entities: ['PER', 'ORG', 'DATE', 'CASE'] } },
    'scan-redact': { enabled: true },
    'geo-mask': { enabled: false },
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
export const BUILTIN_PROFILES: Profile[] = [BASE, GEO, LEGAL, STANDARD, STRICT];

/**
 * Применяет профиль к реестру: включает/выключает зарегистрированные компоненты.
 * Неизвестные id тихо пропускаются; возвращает список пропущенных.
 */
export function applyProfile(
  registry: ComponentRegistry,
  profile: Profile,
): string[] {
  const skipped: string[] = [];
  for (const [id, entry] of Object.entries(profile.components)) {
    if (!registry.has(id)) {
      skipped.push(id);
      continue;
    }
    registry.setEnabled(id, entry.enabled);
  }
  return skipped;
}
