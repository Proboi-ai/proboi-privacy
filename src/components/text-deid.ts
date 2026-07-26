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
import { ENTITY_TYPES, entitiesForVertical, isVertical } from "../deid/entities";
import { createLocalMorphAdapter, NOOP_MORPH, type MorphAdapter } from "../deid/morph";
import {
  createPlaceholderOperator,
  createSurrogateOperator,
  type HideMode,
  type HideOperator,
} from "../deid/operators";
import { PrivacyBlockedError } from "../types";

// Дефолт (без COORD/PASSPORT/INN/PHONE): координаты токенизируем ТОЛЬКО по явному профилю
// geo, а паспорт/ИНН/телефон — по явному запросу — иначе метровые/десятичные числа
// и случайные 10-значные последовательности плодят ложные срабатывания на дефолте.
const ALL_TYPES: EntityType[] = ["PER", "ORG", "DATE", "CASE"];
const ACCEPTED_TYPES: EntityType[] = [...ENTITY_TYPES];
// Natasha NER покрывает только PER/ORG — остальные типы остаются на TS-слое.
const SIDECAR_TYPES: EntityType[] = ["PER", "ORG"];
const TOKEN_RE = /\[[A-Z][A-Z0-9_]*_\d+\]/g;

function readTypes(cfg: Record<string, unknown>): EntityType[] {
  const raw = cfg.entities;
  if (Array.isArray(raw)) {
    const set = raw.filter((t): t is EntityType => ACCEPTED_TYPES.includes(t as EntityType));
    return set.length ? set : ALL_TYPES;
  }
  return isVertical(cfg.vertical) ? entitiesForVertical(cfg.vertical) : ALL_TYPES;
}

/** Токенизирует заданные сущности. Заменяет с конца, чтобы не сбить индексы. */
export function tokenizeEntities(
  text: string,
  ents: DetectedEntity[],
  vault: TokenVault,
  opts?: {
    operator?: HideOperator;
    morph?: MorphAdapter;
    analyses?: ReadonlyMap<string, { lemma: string; form: import("../deid/morph").MorphForm }>;
  },
): { text: string; count: number; lowConfidence: number; replacements: number } {
  if (ents.length === 0) return { text, count: 0, lowConfidence: 0, replacements: 0 };
  let out = text;
  let lowConfidence = 0;
  let replacements = 0;
  const operator = opts?.operator ?? createPlaceholderOperator();
  const taken = new Set(vault.surfaces().map(({ surface }) => surface));
  const ordered = [...ents].sort((a, b) => b.index - a.index);
  for (const e of ordered) {
    if (e.confidence !== "high") lowConfidence++;
    const token = vault.tokenFor(e.type, e.raw);
    let surface = token;
    if (operator.mode === "surrogate") {
      const existing = vault.entry(token)?.surface;
      if (existing) {
        surface = existing;
      } else {
        const analysis =
          opts?.analyses?.get(`${e.type}\0${e.raw}`) ??
          opts?.morph?.analyze(e.raw, e.type);
        surface = operator.render(e.type, token, e.raw, {
          morph: analysis?.form,
          seed: vault.seedFor(e.type, analysis?.lemma ?? e.raw),
          scopeSeed: vault.seedFor("DATE", "__scope__"),
          taken,
          sourceText: text,
        });
        if (surface !== token) {
          vault.setSurface(token, {
            surface,
            lemma: analysis?.lemma,
            morph: analysis?.form as Record<string, string> | undefined,
          });
          taken.add(surface);
        }
      }
      if (surface !== token) replacements++;
    }
    out = out.slice(0, e.index) + surface + out.slice(e.index + e.raw.length);
  }
  return { text: out, count: ents.length, lowConfidence, replacements };
}

/** TS-дефолт: детект + токенизация (без сайдкара). */
export function tokenizeText(
  text: string,
  vault: TokenVault,
  types: EntityType[] = ALL_TYPES,
  opts?: { operator?: HideOperator; morph?: MorphAdapter },
): { text: string; count: number; lowConfidence: number; replacements: number } {
  return tokenizeEntities(text, detectEntities(text, types), vault, opts);
}

/** Возвращает оригиналы на месте токенов (неизвестный токен оставляем как есть). */
export function detokenizeText(text: string, vault: TokenVault): string {
  let out = text;
  for (const { token, surface } of vault.surfaces().sort((a, b) => b.surface.length - a.surface.length)) {
    out = out.split(surface).join(vault.original(token) ?? surface);
  }
  return out.replace(TOKEN_RE, (m) => vault.original(m) ?? m);
}

export function createTextDeidComponent(
  vault: TokenVault,
  opts?: { sidecar?: SidecarManager },
): PrivacyComponent {
  const sidecar = opts?.sidecar;
  const localMorph = createLocalMorphAdapter();

  return {
    id: "text-deid",
    tier: "T1",
    runtime: "ts-spine", // дефолт-путь; upgrade опционален
    configSchema: {
      type: "object",
      properties: {
        entities: { type: "array", items: { type: "string" }, default: ALL_TYPES },
        vertical: { type: "string" },
        hideMode: { type: "string", default: "placeholder" },
        morph: { type: "string", default: "auto" },
        nerEngine: { type: "string", default: "natasha" },
      },
    },

    async beforeEgress(p, ctx: ComponentContext) {
      if (!p.text) return p;
      const types = readTypes(ctx.cfg);
      const hideMode: HideMode = ctx.cfg.hideMode === "surrogate" ? "surrogate" : "placeholder";
      const morphMode = typeof ctx.cfg.morph === "string" ? ctx.cfg.morph : "auto";
      if (hideMode === "surrogate" && morphMode === "off") {
        throw new PrivacyBlockedError("text-deid", "surrogate требует работающую морфологию");
      }
      const morph = morphMode === "off" ? NOOP_MORPH : localMorph;
      const operator =
        hideMode === "surrogate"
          ? createSurrogateOperator({ morph })
          : createPlaceholderOperator();

      // 1) TS-дефолт — всегда (страховочная сетка)
      let ents = detectEntities(p.text, types);
      const engine =
        typeof ctx.cfg.nerEngine === "string"
          ? ctx.cfg.nerEngine
          : process.env.PRIVACY_NER_ENGINE ?? "natasha";
      const requiresGliner = engine === "gliner" || engine === "both";
      if (requiresGliner && (!sidecar || sidecar.status() !== "healthy")) {
        throw new PrivacyBlockedError(
          "text-deid",
          "отраслевая GLiNER-модель недоступна; передача заблокирована",
        );
      }

      // 2) upgrade: сайдкар Natasha, если поднят (PER/ORG), мерж поверх TS
      let usedSidecar = false;
      let glinerFailed = false;
      if (sidecar && sidecar.status() === "healthy") {
        const want = types.filter((t) => SIDECAR_TYPES.includes(t));
        let glinerOk = false;
        if (engine === "gliner" || engine === "both") {
          try {
            const vertical = typeof ctx.cfg.vertical === "string" ? ctx.cfg.vertical : "common";
            const extra = (await sidecar.deidGliner(p.text, vertical))
              .filter((entity) => types.includes(entity.type))
              .map((entity) => ({ ...entity, source: "ner" as const }));
            ents = resolveOverlaps([...ents, ...extra]);
            usedSidecar = true;
            glinerOk = true;
          } catch {
            glinerFailed = true;
          }
        }
        if (want.length && (engine === "natasha" || engine === "both" || !glinerOk)) {
          try {
            const extra = (await sidecar.deid(p.text, want))
              .map((entity) => ({ ...entity, source: "ner" as const }));
            ents = resolveOverlaps([...ents, ...extra]);
            usedSidecar = true;
          } catch {
            /* сайдкар моргнул — остаёмся на TS-дефолте */
          }
        }
      }
      if (glinerFailed) {
        throw new PrivacyBlockedError(
          "text-deid",
          "GLiNER не загрузилась; Natasha/правила выполнены локально, egress заблокирован",
        );
      }

      const analyses = new Map<string, { lemma: string; form: import("../deid/morph").MorphForm }>();
      if (
        hideMode === "surrogate" &&
        morphMode !== "local" &&
        sidecar?.status() === "healthy"
      ) {
        for (const e of ents) {
          try {
            const analysis = await sidecar.morphAnalyze(e.raw, e.type);
            if (analysis) analyses.set(`${e.type}\0${e.raw}`, analysis);
          } catch {
            /* fail-open на local */
          }
        }
      }

      const { text, count, lowConfidence, replacements } = tokenizeEntities(
        p.text,
        ents,
        vault,
        { operator, morph, analyses },
      );
      if (count > 0) {
        ctx.audit({
          ts: ctx.now(),
          component: "text-deid",
          action: "tokenize",
          // ТОЛЬКО метрики — сами PII в квитанцию не пишем
          detail: { count, lowConfidence, sidecar: usedSidecar, hideMode, replacements },
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
