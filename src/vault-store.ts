/**
 * Персистентный ШИФРОВАННЫЙ бэкенд Token Vault.
 *
 * Зачем: TokenVault держал карту токен→оригинал только в RAM (см. vault.ts). Рестарт раннера
 * терял карту → в истории диалога оставались осиротевшие [PER_01], восстановить нельзя. Здесь —
 * durable-стор: строки лежат в sqlite, значение (оригинал ПДн) шифруется AES-256-GCM ПЕРЕД
 * записью; на диске — только шифртекст.
 *
 * Решения (adopt-vs-build — заимствуем ПАТТЕРНЫ, свой код):
 *  - НЕ SQLCipher: он шифрует весь файл (другая задача), нативной поддержки в bun:sqlite нет,
 *    а per-value-шифрование у него коммерческое. Берём паттерн, не код: sqlite хранит opaque BLOB,
 *    конфиденциальность даёт НАШ envelope поверх (та же связка примитивов, что уже в components/).
 *  - Синхронный горячий путь: node:crypto createCipheriv('aes-256-gcm') СИНХРОННЫЙ (в отличие от
 *    crypto.subtle) — tokenFor() остаётся sync, без await в цикле токенизации.
 *  - Формат блоба (в духе SQLCipher-VLE / AWS Encryption-SDK «encryption context»):
 *      [1 байт версия=1] || [12 байт IV] || [ciphertext] || [16 байт GCM-tag]
 *    AAD = `${scope}\0${token}` — привязывает шифртекст к своей строке: переставить блоб на чужой
 *    токен/скоуп нельзя, GCM-тег не сойдётся (защита от replay между строками).
 *  - Ключ строки: HMAC-SHA256(KEK, `${scope}\0${token}`) — свежий подключ на каждое значение
 *    («fresh key per value»), полностью синхронно, без async AES-KW. KEK живёт в keys-компоненте
 *    (защищён DPAPI/keyfile), сюда приходит уже сырыми 32 байтами.
 *  - Дедуп/поиск — в RAM (Map в vault.ts), НЕ запросом по шифрованной колонке, поэтому
 *    детерминированное шифрование (AES-SIV) не нужно: random-IV GCM безопаснее и проще.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export interface VaultEntry {
  token: string;
  type: string;
  /** Каноническая форма — та, что встретилась первой. Её отдаёт `original()`. */
  raw: string;
  /** Ключ дедупа личности (для ФИО — именительный падеж). Нет → ключ равен `raw`. */
  identity?: string;
  lemma?: string;
  morph?: Record<string, string>;
  /** Слово слева → форма оригинала, стоявшая после него. См. deid/identity.ts. */
  uses?: Record<string, string>;
  surface?: string;
  surrogateLemma?: string;
}

export interface VaultStore {
  /** Все записи скоупа (уже расшифрованные) — для гидрации TokenVault при старте. */
  load(scope: string): VaultEntry[];
  /** Персист одной новой записи: значение шифруется перед записью на диск. */
  put(scope: string, entry: VaultEntry): void;
}

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

function aadFor(scope: string, token: string): Buffer {
  return Buffer.from(`${scope}\0${token}`, "utf8");
}

/** Свежий подключ на (scope, token) из мастер-ключа KEK — sync PRF (HMAC как KDF). */
function rowKey(kek: Uint8Array, scope: string, token: string): Buffer {
  return createHmac("sha256", kek).update(`${scope}\0${token}`).digest(); // 32 байта
}

/** Шифрует оригинал → блоб [версия‖IV‖ct‖tag]. Синхронно (node:crypto). */
export function sealValue(kek: Uint8Array, scope: string, token: string, plain: string): Buffer {
  const key = rowKey(kek, scope, token);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(scope, token));
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, ct, tag]);
}

/** Расшифровывает блоб. Чужой KEK / подмена scope+token / порча → исключение (GCM-тег). */
export function openValue(kek: Uint8Array, scope: string, token: string, blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_LEN + TAG_LEN) throw new Error("vault-store: блоб короче минимума");
  const ver = buf[0];
  if (ver !== VERSION) throw new Error(`vault-store: неподдерживаемая версия блоба ${ver}`);
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
  const key = rowKey(kek, scope, token);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aadFor(scope, token));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** In-memory стор (дефолт/тесты). Никакой крипты — эквивалент прежнего RAM-поведения. */
export function memoryVaultStore(): VaultStore {
  const rows: Array<{ scope: string; entry: VaultEntry }> = [];
  return {
    load: (scope) => rows.filter((r) => r.scope === scope).map((r) => ({ ...r.entry })),
    put: (scope, entry) => {
      const i = rows.findIndex((r) => r.scope === scope && r.entry.token === entry.token);
      if (i >= 0) rows[i] = { scope, entry: { ...entry } };
      else rows.push({ scope, entry: { ...entry } });
    },
  };
}

/** Минимальный контракт sqlite-хэндла, который нам нужен (bun:sqlite Database его реализует). */
export interface VaultDb {
  run(sql: string): unknown;
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/**
 * Sqlite-стор: значения шифруются нашим envelope перед записью. key = сырой 32-байт KEK.
 * db — bun:sqlite Database (или совместимый VaultDb; в тестах — тот же bun:sqlite на :memory:/файле).
 */
export function sqliteVaultStore(opts: { db: VaultDb; key: Uint8Array }): VaultStore {
  const { db, key: kek } = opts;
  if (kek.length !== 32) throw new Error(`vault-store: KEK должен быть 32 байта, получено ${kek.length}`);
  db.run(
    "CREATE TABLE IF NOT EXISTS vault (scope TEXT NOT NULL, token TEXT NOT NULL, type TEXT NOT NULL, blob BLOB NOT NULL, PRIMARY KEY (scope, token))",
  );
  const insert = db.query("INSERT OR REPLACE INTO vault (scope, token, type, blob) VALUES (?, ?, ?, ?)");
  const selectScope = db.query("SELECT token, type, blob FROM vault WHERE scope = ?");
  return {
    load: (scope) => {
      const out: VaultEntry[] = [];
      for (const row of selectScope.all(scope) as Array<{ token: string; type: string; blob: Uint8Array }>) {
        const plain = openValue(kek, scope, row.token, row.blob);
        out.push(
          plain.startsWith("\0v2")
            ? JSON.parse(plain.slice(3)) as VaultEntry
            : { token: row.token, type: row.type, raw: plain },
        );
      }
      return out;
    },
    put: (scope, entry) => {
      const blob = sealValue(kek, scope, entry.token, `\0v2${JSON.stringify(entry)}`);
      insert.run(scope, entry.token, entry.type, blob);
    },
  };
}
