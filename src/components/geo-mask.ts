/**
 * PrivacyComponent 'geo-mask' (T1, ts-spine).
 *
 * beforeEgress: токенизирует координаты в тексте (реальная координата → [GEO_NN]),
 *   оригинал уходит в GeoVault на клиенте — наружу (хост-приложение/облако) уходит только токен.
 * afterResponse: ре-идентификация локально (токен → оригинал из vault).
 *
 * Это НАСТОЯЩАЯ стойкость: без vault токен ↔ координату не связать.
 * «Местная СК» (transform.ts) — отдельная usability-обёртка, в egress не участвует.
 */

import type { PrivacyComponent, ComponentContext } from "../types";
import type { GeoVault } from "../geo/vault";
import { detectCoords } from "../geo/coords";

/** Заменяет все координаты в тексте на токены (с конца — чтобы не сбить индексы). */
export function tokenizeCoords(text: string, vault: GeoVault): { text: string; count: number } {
  const coords = detectCoords(text);
  if (coords.length === 0) return { text, count: 0 };
  let out = text;
  const ordered = [...coords].sort((a, b) => b.index - a.index);
  for (const c of ordered) {
    const token = vault.tokenFor(c.raw);
    out = out.slice(0, c.index) + token + out.slice(c.index + c.raw.length);
  }
  return { text: out, count: coords.length };
}

/** Возвращает оригиналы координат на месте токенов (неизвестный токен оставляем как есть). */
export function detokenizeCoords(text: string, vault: GeoVault): string {
  return text.replace(/\[GEO_\d+\]/g, (m) => vault.original(m) ?? m);
}

export function createGeoMaskComponent(vault: GeoVault): PrivacyComponent {
  return {
    id: "geo-mask",
    tier: "T1",
    runtime: "ts-spine",
    configSchema: {
      type: "object",
      properties: {
        sourceCRS: { type: "string", default: "WGS84" }, // система координат входа
        reversible: { type: "boolean", default: true }, // держать vault для ре-ид
      },
    },

    beforeEgress(p, ctx: ComponentContext) {
      if (!p.text) return p;
      const { text, count } = tokenizeCoords(p.text, vault);
      if (count > 0) {
        ctx.audit({
          ts: ctx.now(),
          component: "geo-mask",
          action: "tokenize",
          detail: { count }, // ТОЛЬКО счётчик — сами координаты в квитанцию не пишем
        });
      }
      return { ...p, text };
    },

    afterResponse(p, _ctx: ComponentContext) {
      if (!p.text) return p;
      return { ...p, text: detokenizeCoords(p.text, vault) };
    },
  };
}
