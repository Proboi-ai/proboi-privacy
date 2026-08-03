/**
 * PrivacyComponent 'scan-redact' (T1, ts-spine) — fail-closed заслон для сканов.
 *
 * OCR-redact НЕ реализован: распознавания в модуле нет, значит найти и скрыть
 * ПДн ВНУТРИ картинки нечем. До 03.08.2026 профили обещали компонент
 * 'scan-redact', которого не существовало ни в одном файле: applyProfile тихо
 * пропускал неизвестный id, и скан уходил наружу НЕТРОНУТЫМ. Этот компонент
 * закрывает дыру честно: то, что мы не умеем чистить, наружу не уходит.
 *
 * Что блокируется (PrivacyBlockedError):
 *   • payload с bytes БЕЗ текстового слоя — скан/растровый документ;
 *   • payload с kind из SCAN_KINDS — даже при наличии текста: подпись к
 *     картинке не делает чистой саму картинку.
 * Что проходит: чисто текстовые payload (их чистит text-deid) и bytes С
 * текстовым слоем (docx/pdf с извлечённым текстом — текст уже вычищен выше).
 *
 * Когда появится настоящий OCR-redact (разведка 01.08: tesseract.js на CPU
 * 5–21 с/страница, на объём 1882 сканов нужен GPU) — блокировку заменит
 * распознай→найди→замажь, id и место в профилях уже готовы.
 */

import type { ComponentContext, Payload, PrivacyComponent } from "../types";
import { PrivacyBlockedError } from "../types";

/** Виды payload, которые считаем изображением/сканом независимо от текста. */
const SCAN_KINDS = new Set(["image", "scan", "pdf-scan"]);

/** Скан = картинка по kind, либо байты без текстового слоя. */
export function isScanPayload(p: Payload): boolean {
  if (SCAN_KINDS.has(p.kind)) return true;
  return p.bytes != null && (p.text == null || p.text.trim() === "");
}

export function createScanRedactComponent(): PrivacyComponent {
  return {
    id: "scan-redact",
    tier: "T1",
    runtime: "ts-spine",
    configSchema: { type: "object", properties: {} },

    beforeEgress(p, ctx: ComponentContext) {
      if (!isScanPayload(p)) return p;
      ctx.audit({
        ts: ctx.now(),
        component: "scan-redact",
        action: "block",
        detail: { kind: p.kind, bytes: p.bytes?.length ?? 0 },
      });
      throw new PrivacyBlockedError(
        "scan-redact",
        `скан/растровый документ (kind="${p.kind}") заблокирован: OCR-redact не реализован, ` +
          "непрочищенный скан наружу не уходит (fail-closed)",
      );
    },
  };
}
