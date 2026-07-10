import { describe, it, expect } from 'bun:test';
import { generateKek } from './keys';
import { encryptBytes, decryptBytes, createEnvelopeComponent } from './envelope';

describe('encryptBytes / decryptBytes', () => {
  it('roundtrip: расшифровка == оригинал', async () => {
    const kek = await generateKek();
    const plain = new TextEncoder().encode('секретные данные 42');
    const enc = await encryptBytes(plain, kek);
    const dec = await decryptBytes(enc, kek);
    expect(dec).toEqual(plain);
  });

  it('пустые байты — roundtrip', async () => {
    const kek = await generateKek();
    const enc = await encryptBytes(new Uint8Array(0), kek);
    const dec = await decryptBytes(enc, kek);
    expect(dec).toEqual(new Uint8Array(0));
  });

  it('порча ciphertext → decrypt бросает исключение (GCM auth fail)', async () => {
    const kek = await generateKek();
    const enc = await encryptBytes(new TextEncoder().encode('data'), kek);
    // Портим ct: меняем один байт в конце JSON (модифицируем base64 поле ct)
    const envJson = JSON.parse(new TextDecoder().decode(enc));
    const ctBytes = Buffer.from(envJson.ct as string, 'base64');
    ctBytes[ctBytes.length - 1] ^= 0xff;
    envJson.ct = ctBytes.toString('base64');
    const corrupted = new TextEncoder().encode(JSON.stringify(envJson));
    await expect(decryptBytes(corrupted, kek)).rejects.toThrow();
  });

  it('неверный KEK → decrypt бросает исключение', async () => {
    const kek = await generateKek();
    const wrongKek = await generateKek();
    const enc = await encryptBytes(new TextEncoder().encode('data'), kek);
    await expect(decryptBytes(enc, wrongKek)).rejects.toThrow();
  });
});

describe('createEnvelopeComponent', () => {
  it('atRest шифрует; декрипт возвращает оригинал', async () => {
    const kek = await generateKek();
    const comp = createEnvelopeComponent(kek);
    expect(comp.id).toBe('envelope');
    const plain = new TextEncoder().encode('test payload');
    // atRest возвращает Uint8Array | Promise<Uint8Array> — обёртка через Promise.resolve
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enc = await Promise.resolve(comp.atRest!(plain, {} as any));
    const dec = await decryptBytes(enc, kek);
    expect(dec).toEqual(plain);
  });
});
