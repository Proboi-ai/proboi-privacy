/**
 * Envelope-шифрование: AES-256-GCM.
 * DEK (Data Encryption Key) генерируется на каждый объект.
 * DEK заворачивается KEK-ом через AES-KW.
 *
 * Формат конверта v1 (JSON+base64):
 *   { v:1, iv:"<b64 12>", wrappedDek:"<b64 40>", ct:"<b64 n+16>" }
 * ct включает 16-байт GCM auth-tag в хвосте (WebCrypto возвращает их вместе).
 */

import type { PrivacyComponent, ComponentContext } from '../types';

interface EnvelopeV1 {
  v: 1;
  iv: string;          // base64, 12 байт
  wrappedDek: string;  // base64, 40 байт (AES-KW wrap 256-bit key)
  ct: string;          // base64, ciphertext + 16-байт GCM tag
}

function toB64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/**
 * Конвертирует Uint8Array (любой буфер) в чистый ArrayBuffer для WebCrypto.
 * WebCrypto требует ArrayBuffer, не ArrayBufferLike (SharedArrayBuffer не принимает).
 */
function toAb(u8: Uint8Array): ArrayBuffer {
  const ab: ArrayBuffer = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function fromB64(s: string): ArrayBuffer {
  const buf = Buffer.from(s, 'base64');
  const ab: ArrayBuffer = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * Шифрует plain KEK-ом (AES-KW ключ).
 * Возвращает UTF-8 байты JSON-конверта.
 */
export async function encryptBytes(plain: Uint8Array, kek: CryptoKey): Promise<Uint8Array> {
  const plainAb = toAb(plain);
  // Случайный DEK (AES-256-GCM), 12-байт IV
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, plainAb);
  const wrappedDek = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-KW' });
  const env: EnvelopeV1 = {
    v: 1,
    iv: toB64(iv.buffer as ArrayBuffer),
    wrappedDek: toB64(wrappedDek),
    ct: toB64(ct),
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

/**
 * Расшифровывает конверт KEK-ом.
 * Неверный KEK или порча тега/ciphertext → исключение (GCM auth fail).
 */
export async function decryptBytes(envelopeBytes: Uint8Array, kek: CryptoKey): Promise<Uint8Array> {
  const env = JSON.parse(new TextDecoder().decode(envelopeBytes)) as EnvelopeV1;
  if (env.v !== 1) throw new Error(`Неподдерживаемая версия конверта: ${env.v}`);

  const dek = await crypto.subtle.unwrapKey(
    'raw',
    fromB64(env.wrappedDek),
    kek,
    { name: 'AES-KW' },
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(env.iv) },
    dek,
    fromB64(env.ct),
  );
  return new Uint8Array(plain);
}

/**
 * PrivacyComponent 'envelope'.
 * Реализует хук atRest: шифрует байты при записи на диск.
 * KEK инжектируется снаружи (из keys-компонента).
 */
export function createEnvelopeComponent(kek: CryptoKey): PrivacyComponent {
  return {
    id: 'envelope',
    tier: 'T1',
    runtime: 'ts-spine',
    configSchema: { type: 'object', properties: {} },

    async atRest(bytes: Uint8Array, _ctx: ComponentContext): Promise<Uint8Array> {
      return encryptBytes(bytes, kek);
    },
  };
}
