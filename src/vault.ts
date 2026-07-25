/**
 * TokenVault — обобщённый обратимый сейф де-ид-токенов на КЛИЕНТЕ.
 * Один сейф на все типы обратимых секретов (PER/ORG/DATE/CASE/…): token→оригинал.
 *
 * По умолчанию in-memory на раннере (zero-knowledge — наружу не уходит). При передаче
 * store+scope карта ПЕРЕЖИВАЕТ рестарт — новые токены пишутся в шифрованный стор (vault-store.ts,
 * AES-256-GCM), при старте гидрируются обратно. Наружу ничего не уходит: стор локальный, на диске
 * только шифртекст.
 *
 * Дедуп: один и тот же (тип, оригинал) → один и тот же токен (стабильность для модели и корректная
 * ре-идентификация). Счётчик отдельный на каждый тип. Поиск/дедуп идёт по RAM-карте (byKey), НЕ по
 * шифрованной колонке — поэтому детерминированное шифрование не нужно.
 */

import type { VaultStore } from "./vault-store";

/** Разбирает номер из токена [TYPE_NN] (для восстановления счётчиков при гидрации). */
function tokenNumber(token: string): number | null {
  const m = /_(\d+)\]$/.exec(token);
  return m ? parseInt(m[1]!, 10) : null;
}

export class TokenVault {
  private byToken = new Map<string, string>(); // token → оригинал
  private byKey = new Map<string, string>(); // keyOf(type, raw) → token
  private counters = new Map<string, number>(); // type → последний номер
  private readonly store?: VaultStore;
  private readonly scope?: string;

  /**
   * opts.store + opts.scope → durable-режим: при создании подтягиваем сохранённые токены из стора
   * (расшифровка), при tokenFor новые пишем в стор. Без opts — прежнее поведение (чистый in-memory,
   * байт-в-байт), все существующие `new TokenVault()` целы.
   */
  constructor(opts?: { store?: VaultStore; scope?: string }) {
    this.store = opts?.store;
    this.scope = opts?.scope;
    if (this.store && this.scope !== undefined) {
      for (const e of this.store.load(this.scope)) {
        this.byToken.set(e.token, e.raw);
        this.byKey.set(this.keyOf(e.type, e.raw), e.token);
        const n = tokenNumber(e.token);
        if (n !== null && n > (this.counters.get(e.type) ?? 0)) this.counters.set(e.type, n);
      }
    }
  }

  /**
   * Ключ дедупа для (тип, оригинал).  -разделитель (не может встретиться в тексте) —
   * ЕДИНЫЙ источник формата для tokenFor И гидрации из стора: если они разойдутся, дедуп после
   * рестарта промахнётся и наплодит дубль-токены.
   */
  private keyOf(type: string, raw: string): string {
    return `${type} ${raw}`;
  }

  /** Токен для (тип, оригинал). Формат: [TYPE_NN]. Повтор → тот же токен. */
  tokenFor(type: string, raw: string): string {
    const key = this.keyOf(type, raw);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const token = `[${type}_${String(n).padStart(2, "0")}]`;
    this.byToken.set(token, raw);
    this.byKey.set(key, token);
    // durable: новый токен переживёт рестарт (значение шифруется внутри стора).
    if (this.store && this.scope !== undefined) {
      this.store.put(this.scope, { token, type, raw });
    }
    return token;
  }

  /** Оригинал по токену (ре-идентификация, только локально). */
  original(token: string): string | undefined {
    return this.byToken.get(token);
  }

  /**
   * Список выданных токенов — БЕЗ оригиналов (deid/restore.ts строит по нему индекс для
   * нечёткого сопоставления). Наружу не отдаём ничего, кроме самих ярлыков `[TYPE_NN]`:
   * они не содержат производной от исходного значения, так что список безопасно логировать.
   */
  tokens(): string[] {
    return [...this.byToken.keys()];
  }

  size(): number {
    return this.byToken.size;
  }
}
