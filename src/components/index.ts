/**
 * Фабрики компонентов профиля BASE.
 * id компонентов соответствуют profiles.ts: 'envelope', 'key-store', 'audit-logger'.
 */

export { createEnvelopeComponent } from './envelope';
export { createKeysComponent } from './keys';
export type { KeysComponent } from './keys';
export { createAuditComponent } from './audit';
export type { AuditComponent, AuditRecord, Checkpoint } from './audit';

// гео
export { createGeoMaskComponent, tokenizeCoords, detokenizeCoords } from './geo-mask';

// де-ид текста, TS-дефолт
export { createTextDeidComponent, tokenizeText, detokenizeText } from './text-deid';

// fail-closed заслон для сканов (OCR-redact не реализован)
export { createScanRedactComponent, isScanPayload } from './scan-redact';
