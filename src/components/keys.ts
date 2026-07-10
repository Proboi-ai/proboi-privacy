/**
 * Ключи: 2-слойная защита KEK (Key Encryption Key).
 *
 * Слой 1: recovery-passphrase → scryptSync (node:crypto) → AES-KW wrap KEK.
 *   TODO: argon2id через @noble/hashes (сейчас scrypt без доп. зависимостей).
 *
 * Слой 2 (только Windows): DPAPI (CryptProtectData/CryptUnprotectData) через bun:ffi.
 *   user-scope (НЕ CRYPTPROTECT_LOCAL_MACHINE — см. ниже), machine-bound к учётке юзера.
 *   Вне Windows — dev-фолбэк ГРОМКИЙ и gated: по умолчанию fail-closed, разблокируется
 *   только явным флагом «незащищённый dev-режим» (требование задачи).
 *
 * Модель угроз: DPAPI держит от «другого юзера на ПК / украденного
 * диска», НЕ от админа/малвари. Поэтому scope = user, а НЕ machine:
 *   CRYPTPROTECT_LOCAL_MACHINE дал бы расшифровку ЛЮБОМУ юзеру машины → сломал бы
 *   гарантию «другой юзер не прочтёт». Оставляем user-scope (dwFlags=UI_FORBIDDEN).
 */

import { scryptSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import type { PrivacyComponent } from '../types';

// Параметры scrypt — прод-уровень OWASP (было 16384, поднято по TODO в этом же файле).
const SCRYPT_N = 65536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/**
 * Node/OpenSSL требует явный maxmem для scrypt, если память превышает дефолтные 32MB
 * (N=65536,r=8 ≈ 64MB — уже превышает). Формула памяти scrypt ≈128*N*r*p байт (Percival);
 * берём ×2 запас под накладные расходы OpenSSL. Параметризовано (не жёстко под SCRYPT_N),
 * т.к. unwrap читает N/r/p из СОХРАНЁННОГО файла — старые обёртки (N=16384) тоже проходят.
 */
function scryptMaxMemFor(N: number, r: number, p: number): number {
  return Math.max(32 * 1024 * 1024, 128 * N * r * p * 2);
}

/** Формат хранения KEK, обёрнутого паролем. */
interface WrappedKekV1 {
  v: 1;
  alg: 'scrypt+AES-KW';
  N: number;
  r: number;
  p: number;
  salt: string;    // base64, 16 байт соль scrypt
  wrapped: string; // base64, 40 байт (AES-KW: 32-байт ключ + 8 байт overhead)
}

function toB64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/**
 * Конвертирует Buffer/Uint8Array → чистый ArrayBuffer для WebCrypto.
 * WebCrypto не принимает SharedArrayBuffer (ArrayBufferLike).
 */
function toAb(src: Buffer | Uint8Array): ArrayBuffer {
  const ab: ArrayBuffer = new ArrayBuffer(src.byteLength);
  new Uint8Array(ab).set(src);
  return ab;
}

function fromB64(s: string): ArrayBuffer {
  const buf = Buffer.from(s, 'base64');
  const ab: ArrayBuffer = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** Генерирует новый KEK (AES-256-KW). */
export async function generateKek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey'],
  );
}

/** Оборачивает KEK паролем: scrypt → сырой ключ → AES-KW wrap. */
export async function wrapKekWithPassphrase(kek: CryptoKey, passphrase: string): Promise<Uint8Array> {
  const salt = randomBytes(16);
  const rawAb = toAb(scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: scryptMaxMemFor(SCRYPT_N, SCRYPT_R, SCRYPT_P),
  }));
  const wrappingKey = await crypto.subtle.importKey(
    'raw', rawAb, { name: 'AES-KW' }, false, ['wrapKey'],
  );
  const wrapped = await crypto.subtle.wrapKey('raw', kek, wrappingKey, { name: 'AES-KW' });
  const out: WrappedKekV1 = {
    v: 1, alg: 'scrypt+AES-KW',
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    salt: toB64(toAb(salt)),
    wrapped: toB64(wrapped),
  };
  return new TextEncoder().encode(JSON.stringify(out));
}

/** Разворачивает KEK из passphrase-обёртки. Неверный пароль → исключение. */
export async function unwrapKekWithPassphrase(wrappedBytes: Uint8Array, passphrase: string): Promise<CryptoKey> {
  const w = JSON.parse(new TextDecoder().decode(wrappedBytes)) as WrappedKekV1;
  if (w.v !== 1) throw new Error(`Неподдерживаемый формат обёртки KEK: v=${w.v}`);
  const saltAb = fromB64(w.salt);
  const rawAb = toAb(scryptSync(passphrase, new Uint8Array(saltAb), SCRYPT_KEYLEN, {
    N: w.N, r: w.r, p: w.p, maxmem: scryptMaxMemFor(w.N, w.r, w.p),
  }));
  const wrappingKey = await crypto.subtle.importKey(
    'raw', rawAb, { name: 'AES-KW' }, false, ['unwrapKey'],
  );
  return crypto.subtle.unwrapKey(
    'raw',
    fromB64(w.wrapped),
    wrappingKey,
    { name: 'AES-KW' },
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey'],
  );
}

// ── DPAPI через bun:ffi → Crypt32.dll (реальная защита KEK на Windows) ──────────
//
// DATA_BLOB (x64), 16 байт:
//   offset 0: DWORD  cbData  (4 байт)
//   offset 4: pad            (4 байт — выравнивание указателя)
//   offset 8: BYTE*  pbData  (8 байт)
//
// BOOL CryptProtectData(pDataIn, szDataDescr, pOptionalEntropy, pvReserved,
//                       pPromptStruct, dwFlags, pDataOut);
// CryptUnprotectData — та же раскладка аргументов (ppszDataDescr вместо szDataDescr).

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
// CRYPTPROTECT_LOCAL_MACHINE = 0x4 — СОЗНАТЕЛЬНО не используем (сломал бы user-scope).

const DPAPI_FN = {
  args: [
    FFIType.ptr, // pDataIn:            DATA_BLOB*
    FFIType.ptr, // sz/ppszDataDescr:   LPCWSTR / LPWSTR*
    FFIType.ptr, // pOptionalEntropy:   DATA_BLOB*
    FFIType.ptr, // pvReserved:         PVOID
    FFIType.ptr, // pPromptStruct:      CRYPTPROTECT_PROMPTSTRUCT*
    FFIType.u32, // dwFlags:            DWORD
    FFIType.ptr, // pDataOut:           DATA_BLOB*
  ],
  returns: FFIType.i32, // BOOL
} as const;

type Crypt32 = ReturnType<typeof dlopen>['symbols'];
type Kernel32 = ReturnType<typeof dlopen>['symbols'];
let _crypt32: Crypt32 | null = null;
let _kernel32: Kernel32 | null = null;

/** Ленивая загрузка Crypt32/Kernel32 (только на Windows, один раз). */
function loadDpapi(): { crypt32: Crypt32; kernel32: Kernel32 } {
  if (!_crypt32) {
    _crypt32 = dlopen('Crypt32.dll', {
      CryptProtectData: DPAPI_FN,
      CryptUnprotectData: DPAPI_FN,
    }).symbols;
    // LocalFree освобождает pbData, выделенный DPAPI в pDataOut.
    _kernel32 = dlopen('Kernel32.dll', {
      LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    }).symbols;
  }
  return { crypt32: _crypt32, kernel32: _kernel32! };
}

/** Собирает 16-байтный DATA_BLOB, ссылающийся на data. Держи `data` живой до вызова! */
function makeBlob(data: Uint8Array): Uint8Array {
  const blob = new Uint8Array(16);
  const view = new DataView(blob.buffer);
  view.setUint32(0, data.byteLength, true); // cbData
  const dataPtr = data.byteLength > 0 ? (ptr(data) as unknown as number) : 0;
  view.setBigUint64(8, BigInt(dataPtr), true); // pbData
  return blob;
}

/** Копирует выход DATA_BLOB в JS-массив и освобождает нативную память через LocalFree. */
function readAndFreeBlob(outBlob: Uint8Array, kernel32: Kernel32): Uint8Array {
  const view = new DataView(outBlob.buffer);
  const cb = view.getUint32(0, true);
  const pbNum = Number(view.getBigUint64(8, true));
  const out = new Uint8Array(cb);
  if (cb > 0 && pbNum !== 0) {
    out.set(new Uint8Array(toArrayBuffer(pbNum as unknown as Pointer, 0, cb))); // копия ДО free
    (kernel32.LocalFree as unknown as (p: number) => unknown)(pbNum);
  }
  return out;
}

/** Разрешает ли контекст незащищённый dev-фолбэк (по опции или env). */
function devFallbackAllowed(opts?: DpapiOptions): boolean {
  if (opts?.allowInsecureDevFallback !== undefined) return opts.allowInsecureDevFallback;
  return process.env.PRIVACY_ALLOW_INSECURE_KEYS === '1';
}

export interface DpapiOptions {
  /**
   * Явное разрешение НЕЗАЩИЩЁННОГО dev-режима вне Windows: байты проходят как есть,
   * без защиты ОС. Без него (и без PRIVACY_ALLOW_INSECURE_KEYS=1) — fail-closed (throw).
   */
  allowInsecureDevFallback?: boolean;
}

/** true, если реальный DPAPI доступен (Windows). */
export function dpapiAvailable(): boolean {
  return process.platform === 'win32';
}

/**
 * Защита байт через DPAPI (Windows: CryptProtectData, user-scope).
 * Вне Windows: fail-closed, кроме явно включённого dev-фолбэка (громкий warn).
 */
export async function protectWithDpapi(bytes: Uint8Array, opts?: DpapiOptions): Promise<Uint8Array> {
  if (process.platform === 'win32') {
    const { crypt32, kernel32 } = loadDpapi();
    const inBlob = makeBlob(bytes);
    const outBlob = new Uint8Array(16);
    const ok = (crypt32.CryptProtectData as unknown as (...a: unknown[]) => number)(
      inBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob,
    );
    void bytes; // keep-alive: inBlob держит сырой указатель в bytes до конца вызова
    if (!ok) throw new Error('[privacy/keys] CryptProtectData вернул FALSE (DPAPI-защита не удалась)');
    return readAndFreeBlob(outBlob, kernel32);
  }
  if (devFallbackAllowed(opts)) {
    console.warn(
      '[privacy/keys] ⚠️ НЕЗАЩИЩЁННЫЙ dev-режим: DPAPI недоступен вне Windows, KEK НЕ защищён ОС. ' +
        'Только для разработки — НЕ для прода (allowInsecureDevFallback / PRIVACY_ALLOW_INSECURE_KEYS).',
    );
    return bytes;
  }
  throw new Error(
    '[privacy/keys] DPAPI доступен только на Windows. Вне Windows fail-closed: ' +
      'передай allowInsecureDevFallback:true или PRIVACY_ALLOW_INSECURE_KEYS=1 для незащищённого dev-режима.',
  );
}

/**
 * Снятие защиты DPAPI (Windows: CryptUnprotectData, user-scope).
 * Вне Windows: fail-closed, кроме явно включённого dev-фолбэка.
 */
export async function unprotectWithDpapi(bytes: Uint8Array, opts?: DpapiOptions): Promise<Uint8Array> {
  if (process.platform === 'win32') {
    const { crypt32, kernel32 } = loadDpapi();
    const inBlob = makeBlob(bytes);
    const outBlob = new Uint8Array(16);
    const ok = (crypt32.CryptUnprotectData as unknown as (...a: unknown[]) => number)(
      inBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob,
    );
    void bytes; // keep-alive: inBlob держит сырой указатель в bytes до конца вызова
    if (!ok) {
      throw new Error(
        '[privacy/keys] CryptUnprotectData вернул FALSE — шифртекст от другого юзера/машины ' +
          'или повреждён (DPAPI держит привязку к учётке).',
      );
    }
    return readAndFreeBlob(outBlob, kernel32);
  }
  if (devFallbackAllowed(opts)) {
    return bytes;
  }
  throw new Error(
    '[privacy/keys] DPAPI доступен только на Windows. Вне Windows fail-closed: ' +
      'передай allowInsecureDevFallback:true или PRIVACY_ALLOW_INSECURE_KEYS=1 для незащищённого dev-режима.',
  );
}

// ── Keyfile: стандартный Linux-путь хранения KEK-passphrase (вместо DPAPI) ─────────
//
// DPAPI — только Windows. На Linux (и как явный оверрайд на любой платформе) —
// passphrase лежит в файле на диске (аналог LUKS-keyfile/systemd-creds), права 0600
// (ответственность оператора: генерация/ротация файла вне TS-острова). Мы:
//   1. громко предупреждаем, если права шире 0600 (не блокируем — файл мог прийти
//      из secret-менеджера с иной моделью прав; блокировать было бы surprising);
//   2. scrypt(passphrase) → AES-256-GCM оборачивает сырые байты KEK (тот же примитив
//      защиты содержимого, что и DPAPI-путь, только источник ключа шифрования другой).

/** Формат keyfile-обёртки KEK. */
interface KeyfileProtectedV1 {
  v: 1;
  alg: 'scrypt+AES-GCM';
  N: number;
  r: number;
  p: number;
  salt: string;       // base64, 16 байт соль scrypt
  iv: string;          // base64, 12 байт AES-GCM nonce
  ciphertext: string;  // base64, включает GCM-тег
}

/** Проверяет права keyfile; ГРОМКО предупреждает при отличии от 0600 (не блокирует). */
function warnIfKeyfileTooOpen(keyfilePath: string): void {
  if (process.platform === 'win32') return; // Unix-биты прав здесь неприменимы
  try {
    const mode = statSync(keyfilePath).mode & 0o777;
    if (mode !== 0o600) {
      console.warn(
        `[privacy/keys] ⚠️ keyfile ${keyfilePath} имеет права ${mode.toString(8).padStart(3, '0')}, ` +
          `ожидается 0600 (chmod 600 ${keyfilePath}) — иначе KEK-passphrase читаема другими локальными юзерами.`,
      );
    }
  } catch {
    /* существование файла проверяет readKeyfilePassphrase — здесь best-effort */
  }
}

/** Читает passphrase из keyfile (единственный завершающий перевод строки обрезается). */
function readKeyfilePassphrase(keyfilePath: string): string {
  if (!existsSync(keyfilePath)) {
    throw new Error(
      `[privacy/keys] keyfile не найден: ${keyfilePath} (opts.keyfilePath / PRIVACY_KEK_KEYFILE)`,
    );
  }
  warnIfKeyfileTooOpen(keyfilePath);
  const raw = readFileSync(keyfilePath, 'utf8').replace(/\r?\n$/, '');
  if (!raw) throw new Error(`[privacy/keys] keyfile пуст: ${keyfilePath}`);
  return raw;
}

/**
 * Защита байт через keyfile-passphrase: scrypt → AES-256-GCM. Работает на ЛЮБОЙ платформе
 * (в отличие от protectWithDpapi) — стандартный Linux-путь хранения KEK.
 */
export async function protectWithKeyfile(bytes: Uint8Array, keyfilePath: string): Promise<Uint8Array> {
  const passphrase = readKeyfilePassphrase(keyfilePath);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const rawKeyAb = toAb(scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: scryptMaxMemFor(SCRYPT_N, SCRYPT_R, SCRYPT_P),
  }));
  const aesKey = await crypto.subtle.importKey('raw', rawKeyAb, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toAb(iv) }, aesKey, toAb(bytes));
  const out: KeyfileProtectedV1 = {
    v: 1, alg: 'scrypt+AES-GCM',
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    salt: toB64(toAb(salt)), iv: toB64(toAb(iv)), ciphertext: toB64(ciphertext),
  };
  return new TextEncoder().encode(JSON.stringify(out));
}

/** Снятие keyfile-защиты. Неверная passphrase / чужой файл / порча → исключение (GCM-тег не сойдётся). */
export async function unprotectWithKeyfile(bytes: Uint8Array, keyfilePath: string): Promise<Uint8Array> {
  const passphrase = readKeyfilePassphrase(keyfilePath);
  const w = JSON.parse(new TextDecoder().decode(bytes)) as KeyfileProtectedV1;
  if (w.v !== 1 || w.alg !== 'scrypt+AES-GCM') {
    throw new Error(`[privacy/keys] Неподдерживаемый формат keyfile-обёртки: v=${w.v}, alg=${w.alg}`);
  }
  const rawKeyAb = toAb(scryptSync(passphrase, new Uint8Array(fromB64(w.salt)), SCRYPT_KEYLEN, {
    N: w.N, r: w.r, p: w.p, maxmem: scryptMaxMemFor(w.N, w.r, w.p),
  }));
  const aesKey = await crypto.subtle.importKey('raw', rawKeyAb, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(w.iv) }, aesKey, fromB64(w.ciphertext));
  return new Uint8Array(plain);
}

/** Расширенный интерфейс: компонент плюс доступ к KEK. */
export interface KeysComponent extends PrivacyComponent {
  /** Возвращает актуальный KEK (генерирует при первом вызове, если не передан). */
  getKek(): Promise<CryptoKey>;
}

/** Инъекция DPAPI-функций (реальные по умолчанию; фейки — в тестах). */
export interface DpapiLike {
  protect(bytes: Uint8Array): Promise<Uint8Array>;
  unprotect(bytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * Фабрика: PrivacyComponent 'key-store'.
 * opts.kek: уже загруженный KEK (для тестов и горячей перезагрузки).
 * opts.keyDir: директория ДОЛГОВЕЧНОГО хранения KEK (`<keyDir>/kek.dpapi`, защищён keyfile/DPAPI —
 *   имя файла историческое, формат внутри опознаёт себя по alg). Без keyDir — прежнее поведение
 *   (ephemeral KEK, назад-совместимо с существующими тестами).
 * opts.keyfilePath: путь к passphrase-файлу (или env PRIVACY_KEK_KEYFILE) — стандартный Linux-путь
 *   хранения KEK. Если задан (опцией ИЛИ env) — используется на ЛЮБОЙ платформе вместо DPAPI.
 * opts.dpapi: явная инъекция protect/unprotect (тесты — фейк-реверсируемая обёртка; прод-дефолт
 *   без keyfilePath — реальный DPAPI). Имеет приоритет над keyfilePath, если передана явно.
 *
 * Приоритет источника защиты: opts.dpapi (явная инъекция) → keyfilePath (opts или env) → DPAPI
 * (Windows) / fail-closed (везде ещё). Без keyDir/keyfilePath/dpapi поведение не меняется.
 */
export function createKeysComponent(opts?: {
  kek?: CryptoKey;
  keyDir?: string;
  keyfilePath?: string;
  dpapi?: DpapiLike;
}): KeysComponent {
  let _kek: CryptoKey | null = opts?.kek ?? null;
  const keyDir = opts?.keyDir;
  const keyfilePath = opts?.keyfilePath ?? process.env.PRIVACY_KEK_KEYFILE;
  const dpapi: DpapiLike =
    opts?.dpapi ??
    (keyfilePath
      ? {
          protect: (bytes: Uint8Array) => protectWithKeyfile(bytes, keyfilePath),
          unprotect: (bytes: Uint8Array) => unprotectWithKeyfile(bytes, keyfilePath),
        }
      : { protect: protectWithDpapi, unprotect: unprotectWithDpapi });

  return {
    id: 'key-store',
    tier: 'T0',
    runtime: 'ts-spine',
    configSchema: { type: 'object', properties: {} },

    /** Компонент «готов» только если KEK загружен. */
    available(): boolean {
      return _kek !== null;
    },

    async getKek(): Promise<CryptoKey> {
      if (_kek) return _kek;

      // Без keyDir — прежнее (тестами проверенное) поведение: эфемерный KEK в памяти.
      if (!keyDir) {
        _kek = await generateKek();
        return _kek;
      }

      const kekPath = join(keyDir, 'kek.dpapi');

      // Первый запуск после установки: файла нет → сгенерировать, защитить DPAPI, сохранить.
      if (!existsSync(kekPath)) {
        const kek = await generateKek();
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kek));
        const protectedBytes = await dpapi.protect(raw);
        mkdirSync(keyDir, { recursive: true });
        writeFileSync(kekPath, Buffer.from(protectedBytes));
        _kek = kek;
        return _kek;
      }

      // Повторный запуск: снять DPAPI-защиту с сохранённого файла и восстановить KEK.
      const protectedBytes = new Uint8Array(readFileSync(kekPath));
      const raw = await dpapi.unprotect(protectedBytes);
      _kek = await crypto.subtle.importKey('raw', toAb(raw), { name: 'AES-KW' }, true, ['wrapKey', 'unwrapKey']);
      return _kek;
    },
  };
}
