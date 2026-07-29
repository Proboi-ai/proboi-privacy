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

import { createHmac, randomBytes } from "node:crypto";
import type { VaultEntry, VaultStore } from "./vault-store";

/** Потолок слов-подсказок на одну личность: документ длинный, а запись сейфа должна быть конечной. */
const MAX_USES = 64;

/** Разбирает номер из токена [TYPE_NN] (для восстановления счётчиков при гидрации). */
function tokenNumber(token: string): number | null {
  const m = /_(\d+)\]$/.exec(token);
  return m ? parseInt(m[1]!, 10) : null;
}

export class TokenVault {
  private byToken = new Map<string, VaultEntry>(); // token → локальная запись
  private byKey = new Map<string, string>(); // keyOf(type, raw) → token
  private counters = new Map<string, number>(); // type → последний номер
  private readonly store?: VaultStore;
  private readonly scope?: string;
  private readonly scopeSalt: Uint8Array;

  /**
   * opts.store + opts.scope → durable-режим: при создании подтягиваем сохранённые токены из стора
   * (расшифровка), при tokenFor новые пишем в стор. Без opts — прежнее поведение (чистый in-memory,
   * байт-в-байт), все существующие `new TokenVault()` целы.
   */
  constructor(opts?: { store?: VaultStore; scope?: string; seedKey?: Uint8Array }) {
    this.store = opts?.store;
    this.scope = opts?.scope;
    this.scopeSalt = opts?.seedKey
      ? createHmac("sha256", opts.seedKey).update(opts.scope ?? "default").digest()
      : randomBytes(32);
    if (this.store && this.scope !== undefined) {
      for (const e of this.store.load(this.scope)) {
        this.byToken.set(e.token, e);
        // Записи, сделанные до появления ключа личности, его не несут — гидрируем по сырой
        // строке, то есть ровно с прежним поведением. Отдельная миграция не нужна: новые
        // формы того же человека просто заведут новый токен, старые продолжат разрешаться.
        this.byKey.set(this.keyOf(e.type, e.identity ?? e.raw), e.token);
        const n = tokenNumber(e.token);
        if (n !== null && n > (this.counters.get(e.type) ?? 0)) this.counters.set(e.type, n);
      }
    }
  }

  /**
   * Ключ дедупа для (тип, ЛИЧНОСТЬ).  -разделитель (не может встретиться в тексте) —
   * ЕДИНЫЙ источник формата для tokenFor И гидрации из стора: если они разойдутся, дедуп после
   * рестарта промахнётся и наплодит дубль-токены.
   *
   * Личность — это лемма, если вызывающий её посчитал (для ФИО — именительный падеж), иначе
   * сама строка. Поэтому «Иванов И.П.», «Иванову И.П.» и «Ивановым И.П.» дают ОДИН токен:
   * для модели это один человек. Какая форма где стояла — в `uses`, см. deid/identity.ts.
   */
  private keyOf(type: string, identity: string): string {
    return `${type}\0${identity}`;
  }

  /**
   * Токен для (тип, оригинал). Формат: [TYPE_NN]. Повтор → тот же токен.
   *
   * `identity` — ключ личности (лемма); не задан → ключом остаётся сама строка, то есть
   * прежнее поведение байт-в-байт. `raw` первого вхождения становится канонической формой,
   * которую отдаёт `original()`.
   */
  tokenFor(type: string, raw: string, identity?: string): string {
    const key = this.keyOf(type, identity ?? raw);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const token = `[${type}_${String(n).padStart(2, "0")}]`;
    const entry: VaultEntry = { token, type, raw, ...(identity === undefined ? {} : { identity }) };
    this.byToken.set(token, entry);
    this.byKey.set(key, token);
    // durable: новый токен переживёт рестарт (значение шифруется внутри стора).
    if (this.store && this.scope !== undefined) {
      this.store.put(this.scope, entry);
    }
    return token;
  }

  /**
   * Запоминает, какая форма оригинала стояла после слова `cue`: «направлено» → «Иванову И.П.».
   * Первое наблюдение выигрывает — так возврат детерминирован и не зависит от порядка обхода.
   * Потолок на число подсказок держит запись сейфа ограниченной на документах любой длины.
   */
  recordUse(token: string, cue: string, form: string): void {
    const current = this.byToken.get(token);
    if (!current || !cue) return;
    const uses = current.uses ?? {};
    if (uses[cue] !== undefined || Object.keys(uses).length >= MAX_USES) return;
    const next = { ...current, uses: { ...uses, [cue]: form } };
    this.byToken.set(token, next);
    if (this.store && this.scope !== undefined) this.store.put(this.scope, next);
  }

  /** Наблюдённая форма для этого слова-подсказки; не встречалась → undefined. */
  useFor(token: string, cue: string): string | undefined {
    return this.byToken.get(token)?.uses?.[cue];
  }

  /**
   * ВСЕ известные написания оригиналов — канонические формы и все наблюдённые падежные.
   * Нужны fail-closed проверкам («в собранном файле не осталось ни одного оригинала»):
   * `original()` отдаёт лишь каноническую форму, и проверка по ней одной пропустила бы
   * «Иванову И.П.» в тексте.
   */
  originals(): string[] {
    const out = new Set<string>();
    for (const e of this.byToken.values()) {
      out.add(e.raw);
      if (e.lemma) out.add(e.lemma);
      for (const form of Object.values(e.uses ?? {})) out.add(form);
    }
    return [...out];
  }

  /** Оригинал по токену (ре-идентификация, только локально). */
  original(token: string): string | undefined {
    return this.byToken.get(token)?.raw;
  }

  entry(token: string): Readonly<VaultEntry> | undefined {
    return this.byToken.get(token);
  }

  setSurface(
    token: string,
    value: Pick<VaultEntry, "surface" | "lemma" | "morph" | "surrogateLemma">,
  ): void {
    const current = this.byToken.get(token);
    if (!current) throw new Error(`TokenVault: неизвестный токен ${token}`);
    const next = { ...current, ...value };
    this.byToken.set(token, next);
    if (this.store && this.scope !== undefined) this.store.put(this.scope, next);
  }

  surfaces(): Array<{ token: string; surface: string }> {
    return [...this.byToken.values()]
      .filter((e): e is VaultEntry & { surface: string } => Boolean(e.surface))
      .map(({ token, surface }) => ({ token, surface }));
  }

  /** Детерминированный seed внутри tenant scope; исходное значение наружу не выводится. */
  seedFor(type: string, value: string): number {
    return createHmac("sha256", this.scopeSalt)
      .update(`${type}\0${value}`)
      .digest()
      .readUInt32BE(0);
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
