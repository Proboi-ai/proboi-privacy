/**
 * Тесты абстракции kmsProvider (kms.ts): формат самоописывающегося блоба, локальный
 * провайдер, эталонный Vault-Transit адаптер (мок fetch), реестр-роутинг, PKCS#11-заглушка,
 * и интеграция с keys.ts (KEK обёрнут KMS, переживает "рестарт").
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  sealKek,
  openKek,
  providerIdOf,
  localKmsProvider,
  vaultTransitKmsProvider,
  pkcs11KmsProviderStub,
  type WrapUnwrapLike,
} from "./kms";
import { createKeysComponent } from "./keys";

/** Обратимая фейк-защита: префикс-маркер 0xAA (доказывает, что wrap реально сработал). */
const fakeLocal: WrapUnwrapLike = {
  protect: async (b) => new Uint8Array([0xaa, ...b]),
  unprotect: async (b) => {
    if (b[0] !== 0xaa) throw new Error("fakeLocal: чужой блоб");
    return b.subarray(1);
  },
};

/** Фейковый Vault Transit: in-memory ciphertext↔plaintext, роутит encrypt/decrypt. */
function fakeVaultFetch(): typeof fetch {
  const store = new Map<string, string>(); // ciphertext -> plaintext(base64)
  let n = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.includes("/v1/transit/encrypt/")) {
      const ct = `vault:v1:ct${n++}`;
      store.set(ct, body.plaintext);
      return new Response(JSON.stringify({ data: { ciphertext: ct } }), { status: 200 });
    }
    if (u.includes("/v1/transit/decrypt/")) {
      const pt = store.get(body.ciphertext);
      if (pt === undefined) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ data: { plaintext: pt } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("kms: формат блоба + реестр", () => {
  test("sealKek → заголовок '<id>:v1:'; providerIdOf читает id", async () => {
    const p = localKmsProvider(fakeLocal, "local");
    const blob = await sealKek(p, new Uint8Array([1, 2, 3]));
    expect(new TextDecoder().decode(blob)).toMatch(/^local:v1:/);
    expect(providerIdOf(blob)).toBe("local");
  });

  test("round-trip через localKmsProvider", async () => {
    const p = localKmsProvider(fakeLocal, "local");
    const secret = new Uint8Array(randomBytes(32));
    const blob = await sealKek(p, secret);
    const back = await openKek(blob, { local: p });
    expect(Buffer.from(back).equals(Buffer.from(secret))).toBe(true);
  });

  test("openKek: провайдера нет в реестре → ошибка (обёрнут другим KMS)", async () => {
    const p = localKmsProvider(fakeLocal, "local");
    const blob = await sealKek(p, new Uint8Array([9]));
    await expect(openKek(blob, { другой: p })).rejects.toThrow(/не зарегистрирован/);
  });

  test("openKek: не наш формат → ошибка", async () => {
    await expect(openKek(new TextEncoder().encode("просто мусор"), {})).rejects.toThrow(/без заголовка/);
  });

  test("id с ':' запрещён", async () => {
    const bad = { ...localKmsProvider(fakeLocal), id: "a:b" };
    await expect(sealKek(bad, new Uint8Array([1]))).rejects.toThrow(/':'/);
  });
});

describe("kms: Vault Transit адаптер (мок fetch)", () => {
  test("wrap→unwrap через фейковый Vault; на диске лежит 'vault:v1:' payload", async () => {
    const provider = vaultTransitKmsProvider({
      addr: "https://vault.local:8200/",
      token: "t0ken",
      keyName: "proboi-kek",
      fetchImpl: fakeVaultFetch(),
    });
    const kek = new Uint8Array(randomBytes(32));
    const blob = await sealKek(provider, kek);
    expect(new TextDecoder().decode(blob)).toMatch(/^vault-transit:v1:/);
    const back = await openKek(blob, { "vault-transit": provider });
    expect(Buffer.from(back).equals(Buffer.from(kek))).toBe(true);
  });

  test("HTTP-ошибка Vault → исключение (fail-closed)", async () => {
    const provider = vaultTransitKmsProvider({
      addr: "https://vault.local",
      token: "bad",
      keyName: "k",
      fetchImpl: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(provider.wrap(new Uint8Array([1]))).rejects.toThrow(/HTTP 403/);
  });
});

describe("kms: PKCS#11 шов", () => {
  test("заглушка бросает (нет тихого обхода)", async () => {
    const p = pkcs11KmsProviderStub();
    expect(p.id).toBe("pkcs11");
    await expect(p.wrap(new Uint8Array([1]))).rejects.toThrow(/без реализации/);
    await expect(p.unwrap(new Uint8Array([1]))).rejects.toThrow(/без реализации/);
  });
});

describe("kms: интеграция с keys.ts (KEK обёрнут KMS, переживает рестарт)", () => {
  test("createKeysComponent({keyDir, kms}) → на диске KMS-блоб; новый компонент восстанавливает тот же KEK", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kms-keys-"));
    try {
      const kms = localKmsProvider(fakeLocal, "clientkms");

      const c1 = createKeysComponent({ keyDir: dir, kms });
      const kek1 = await c1.getKek();
      const raw1 = new Uint8Array(await crypto.subtle.exportKey("raw", kek1));

      // на диске — самоописывающийся KMS-блоб, а не сырой ключ
      const onDisk = readFileSync(join(dir, "kek.dpapi"));
      expect(new TextDecoder().decode(onDisk)).toMatch(/^clientkms:v1:/);

      // "рестарт": новый компонент на том же keyDir+kms → тот же KEK
      const c2 = createKeysComponent({ keyDir: dir, kms });
      const raw2 = new Uint8Array(await crypto.subtle.exportKey("raw", await c2.getKek()));
      expect(Buffer.from(raw2).equals(Buffer.from(raw1))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
