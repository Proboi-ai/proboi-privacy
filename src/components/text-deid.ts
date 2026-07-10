/**
 * PrivacyComponent 'text-deid' (T1).
 *
 * Два уровня recall (council):
 *   • TS-дефолт (ts-spine, всегда): detect.ts — regex+словарь, ~80%, ноль деп.
 *   • upgrade (py-sidecar, если healthy): Natasha ~95% F1 — МЕРЖИТСЯ поверх TS.
 * Сайдкар недоступен → работает TS-дефолт (не хард-блок: text-deid всегда что-то
 * маскирует; хард fail-closed — у sidecar-ONLY компонентов).
 *
 * beforeEgress: PII → токены [PER_01]/[ORG_01]/…, оригиналы в TokenVault на клиенте.
 * afterResponse: ре-идентификация локально.
 */

import type { PrivacyComponent, ComponentContext } from "../types";
import type { TokenVault } from "../vault";
import type { SidecarManager } from "../sidecar";
import { detectEntities, resolveOverlaps, type DetectedEntity, type EntityType } from "../deid/detect";

// Дефолт (без COORD): координаты токенизируем ТОЛЬКО по явному профилю geo, а не
// «на всякий случай» — иначе метровые/десятичные числа плодят ложные срабатывания.
const ALL_TYPES: EntityType[] = ["PER", "ORG", "DATE", "CASE"];
// Допустимые в cfg.entities типы (шире дефолта): COORD валиден для geo-профиля.
const ACCEPTED_TYPES: EntityType[] = [...ALL_TYPES, "COORD"];
// Natasha NER покрывает только PER/ORG — даты/№дел/координаты остаются на TS-слое.
const SIDECAR_TYPES: EntityType[] = ["PER", "ORG"];
const TOKEN_RE = /\[(?:PER|ORG|DATE|CASE|COORD)_\d+\]/g;

function readTypes(cfg: Record<string, unknown>): EntityType[] {
  const raw = cfg.entities;
  if (!Array.isArray(raw)) return ALL_TYPES;
  const set = raw.filter((t): t is EntityType => ACCEPTED_TYPES.includes(t as EntityType));
  return set.length ? set : ALL_TYPES;
}

/** Токенизирует заданные сущности. Заменяет с конца, чтобы не сбить индексы. */
export function tokenizeEntities(
  text: string,
  ents: DetectedEntity[],
  vault: TokenVault,
): { text: string; count: number; lowConfidence: number } {
  if (ents.length === 0) return { text, count: 0, lowConfidence: 0 };
  let out = text;
  let lowConfidence = 0;
  const ordered = [...ents].sort((a, b) => b.index - a.index);
  for (const e of ordered) {
    if (e.confidence !== "high") lowConfidence++;
    const token = vault.tokenFor(e.type, e.raw);
    out = out.slice(0, e.index) + token + out.slice(e.index + e.raw.length);
  }
  return { text: out, count: ents.length, lowConfidence };
}

/** TS-дефолт: детект + токенизация (без сайдкара). */
export function tokenizeText(
  text: string,
  vault: TokenVault,
  types: EntityType[] = ALL_TYPES,
): { text: string; count: number; lowConfidence: number } {
  return tokenizeEntities(text, detectEntities(text, types), vault);
}

/** Возвращает оригиналы на месте токенов (неизвестный токен оставляем как есть). */
export function detokenizeText(text: string, vault: TokenVault): string {
  return text.replace(TOKEN_RE, (m) => vault.original(m) ?? m);
}

export function createTextDeidComponent(
  vault: TokenVault,
  opts?: { sidecar?: SidecarManager },
): PrivacyComponent {
  const sidecar = opts?.sidecar;

  return {
    id: "text-deid",
    tier: "T1",
    runtime: "ts-spine", // дефолт-путь; upgrade опционален
    configSchema: {
      type: "object",
      properties: {
        entities: { type: "array", items: { type: "string" }, default: ALL_TYPES },
      },
    },

    async beforeEgress(p, ctx: ComponentContext) {
      if (!p.text) return p;
      const types = readTypes(ctx.cfg);

      // 1) TS-дефолт — всегда (страховочная сетка)
      let ents = detectEntities(p.text, types);

      // 2) upgrade: сайдкар Natasha, если поднят (PER/ORG), мерж поверх TS
      let usedSidecar = false;
      if (sidecar && sidecar.status() === "healthy") {
        const want = types.filter((t) => SIDECAR_TYPES.includes(t));
        if (want.length) {
          try {
            const extra = await sidecar.deid(p.text, want);
            ents = resolveOverlaps([...ents, ...extra]);
            usedSidecar = true;
          } catch {
            /* сайдкар моргнул — остаёмся на TS-дефолте */
          }
        }
      }

      const { text, count, lowConfidence } = tokenizeEntities(p.text, ents, vault);
      if (count > 0) {
        ctx.audit({
          ts: ctx.now(),
          component: "text-deid",
          action: "tokenize",
          // ТОЛЬКО метрики — сами PII в квитанцию не пишем
          detail: { count, lowConfidence, sidecar: usedSidecar },
        });
      }
      return { ...p, text };
    },

    afterResponse(p, _ctx: ComponentContext) {
      if (!p.text) return p;
      return { ...p, text: detokenizeText(p.text, vault) };
    },
  };
}
