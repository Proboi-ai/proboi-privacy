/**
 * GeoVault — обратимый сейф гео-секретов на КЛИЕНТЕ.
 * Держит token→оригинал (для ре-идентификации) и «ключ перехода» местной СК.
 *
 * Сейчас: in-memory, живёт только на раннере (zero-knowledge — наружу не уходит).
 * В перспективе вливается в общий envelope-шифрованный vault де-ид-токенов — один
 * сейф на все обратимые секреты, не плодим форматы.
 */

import type { LocalCSKey } from "./transform";

export class GeoVault {
  private byToken = new Map<string, string>(); // token → raw оригинал
  private byRaw = new Map<string, string>(); // raw → token (дедуп: одна координата = один токен)
  private counter = 0;
  private csKey: LocalCSKey | null = null;

  /** Токен для координаты; одинаковый raw → один и тот же токен (стабильность для модели). */
  tokenFor(raw: string): string {
    const existing = this.byRaw.get(raw);
    if (existing) return existing;
    const token = `[GEO_${String(++this.counter).padStart(2, "0")}]`;
    this.byToken.set(token, raw);
    this.byRaw.set(raw, token);
    return token;
  }

  /** Оригинал по токену (ре-идентификация, только локально). */
  original(token: string): string | undefined {
    return this.byToken.get(token);
  }

  size(): number {
    return this.byToken.size;
  }

  /** «Ключ перехода» местной СК — секрет клиента; без него местная СК не вскрывается. */
  setLocalCSKey(key: LocalCSKey): void {
    this.csKey = key;
  }
  localCSKey(): LocalCSKey | null {
    return this.csKey;
  }
}
