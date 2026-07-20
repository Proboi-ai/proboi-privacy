/**
 * kmsProvider: сменный провайдер обёртки/разворота МАСТЕР-КЛЮЧА (KEK).
 *
 * Мастер-ключ (KEK) не должен лежать на раннере в открытом виде. По умолчанию его защищает
 * локальный провайдер (DPAPI на Windows / scrypt-keyfile на Linux — уже в keys.ts). Enterprise-клиент
 * может подключить СВОЙ KMS/HSM: тогда KEK оборачивается его ключом, и на диске раннера лежит блоб,
 * который расшифровать может только клиентский KMS/HSM (раннер сам — нет).
 *
 * Самоописывающийся формат блоба (заимствован у HashiCorp Vault Transit `vault:v1:…`):
 *     "<providerId>:v1:<base64(payload)>"
 * providerId в заголовке → на разворот роутим в нужный провайдер из реестра, не гадая по конфигу
 * (если клиент сменил KMS — старый блоб честно скажет, кем обёрнут).
 *
 * Решения (adopt-vs-build — заимствуем паттерны, свой код):
 *  - Интерфейс provider'а — минимальный функциональный wrap/unwrap (по Infisical/Tink KmsClient),
 *    без тяжёлого «materials»-объекта: мы всегда оборачиваем ОДИН KEK, не набор алгоритмов.
 *  - Реестр по префиксу-id (по Tink KmsClient.supports(keyUri)) — так VaultTransit и (будущий) PKCS#11
 *    подключаются как два инстанса одного контракта под одним call-site.
 *  - НЕ вендорим Tink (архивирован, нет TS-биндинга) и node-vault: Vault Transit — 2 JSON-POST
 *    эндпоинта, Bun native fetch, ~1 файл.
 */

export interface KmsProvider {
  /** Короткий id провайдера, попадает в заголовок блоба (без символа ':'). */
  readonly id: string;
  /** Обернуть сырой ключ (DPAPI/keyfile/HTTP-KMS/HSM). Возвращает payload БЕЗ заголовка. */
  wrap(plain: Uint8Array): Promise<Uint8Array>;
  /** Развернуть payload обратно в сырой ключ. Чужой ключ/порча → исключение. */
  unwrap(payload: Uint8Array): Promise<Uint8Array>;
}

const HEADER_RE = /^([a-z0-9._-]+):v1:([\s\S]*)$/;

/** Оборачивает plain провайдером и добавляет самоописывающийся заголовок `<id>:v1:<b64>`. */
export async function sealKek(provider: KmsProvider, plain: Uint8Array): Promise<Uint8Array> {
  if (provider.id.includes(":")) throw new Error(`kms: id провайдера не может содержать ':' (${provider.id})`);
  const payload = await provider.wrap(plain);
  const s = `${provider.id}:v1:${Buffer.from(payload).toString("base64")}`;
  return new TextEncoder().encode(s);
}

/** id провайдера из заголовка блоба (для диагностики/роутинга), либо null если формат не наш. */
export function providerIdOf(blob: Uint8Array): string | null {
  const m = HEADER_RE.exec(new TextDecoder().decode(blob));
  return m ? m[1]! : null;
}

/** Разворачивает блоб: провайдер выбирается по заголовку из реестра. */
export async function openKek(blob: Uint8Array, registry: Record<string, KmsProvider>): Promise<Uint8Array> {
  const m = HEADER_RE.exec(new TextDecoder().decode(blob));
  if (!m) throw new Error("kms: блоб без заголовка '<provider>:v1:' — обёрнут не через kmsProvider?");
  const provider = registry[m[1]!];
  if (!provider) throw new Error(`kms: провайдер "${m[1]}" не зарегистрирован (ключ обёрнут другим KMS?)`);
  return provider.unwrap(new Uint8Array(Buffer.from(m[2]!, "base64")));
}

// ── Провайдеры ───────────────────────────────────────────────────────────────

/** Пара protect/unprotect (тот же контракт, что DpapiLike в keys.ts — DPAPI/keyfile). */
export interface WrapUnwrapLike {
  protect(bytes: Uint8Array): Promise<Uint8Array>;
  unprotect(bytes: Uint8Array): Promise<Uint8Array>;
}

/** Локальный провайдер поверх DPAPI/keyfile — ДЕФОЛТ (мастер-ключ защищён ОС/keyfile). */
export function localKmsProvider(local: WrapUnwrapLike, id = "local"): KmsProvider {
  return {
    id,
    wrap: (plain) => local.protect(plain),
    unwrap: (payload) => local.unprotect(payload),
  };
}

/**
 * Эталонный адаптер к HashiCorp Vault Transit (клиентский KMS «encrypt/decrypt as a service»).
 * KEK оборачивается POST /v1/transit/encrypt/:key, разворачивается /decrypt/:key. Vault отдаёт
 * ciphertext строкой "vault:vN:<b64>" — храним её как наш payload as-is (версия ключа Vault
 * встроена в неё, ротацию Vault переживём). Работает одинаково в air-gap: Vault просто должен быть
 * достижим в контуре клиента. НЕ вендорим node-vault — Bun native fetch.
 */
export function vaultTransitKmsProvider(opts: {
  addr: string; // напр. https://vault.client.local:8200
  token: string; // Vault token
  keyName: string; // имя transit-ключа
  namespace?: string; // Vault Enterprise namespace (опц.)
  id?: string;
  fetchImpl?: typeof fetch; // инъекция для тестов
}): KmsProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.addr.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "X-Vault-Token": opts.token,
    "Content-Type": "application/json",
  };
  if (opts.namespace) headers["X-Vault-Namespace"] = opts.namespace;

  async function transit(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}/v1/transit/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`vault-transit ${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    id: opts.id ?? "vault-transit",
    async wrap(plain) {
      const j = await transit(`encrypt/${encodeURIComponent(opts.keyName)}`, {
        plaintext: Buffer.from(plain).toString("base64"),
      });
      const ct = (j.data as { ciphertext?: string } | undefined)?.ciphertext;
      if (!ct) throw new Error("vault-transit: в ответе нет data.ciphertext");
      return new TextEncoder().encode(ct); // "vault:v1:…" целиком
    },
    async unwrap(payload) {
      const ciphertext = new TextDecoder().decode(payload);
      const j = await transit(`decrypt/${encodeURIComponent(opts.keyName)}`, { ciphertext });
      const b64 = (j.data as { plaintext?: string } | undefined)?.plaintext;
      if (!b64) throw new Error("vault-transit: в ответе нет data.plaintext");
      return new Uint8Array(Buffer.from(b64, "base64"));
    },
  };
}

/**
 * Документированный ШОВ под клиентский HSM по PKCS#11. Реализации по умолчанию НЕТ намеренно:
 * нативные Node-биндинги (graphene/pkcs11js) заброшены и несут дисклеймер «не для прода».
 * Интегратор подставляет wrap/unwrap через C_WrapKey/C_UnwrapKey СВОЕГО HSM и регистрирует провайдер
 * под этим же id. Вызов до реализации — явная ошибка (fail-closed), а не тихий обход.
 */
export function pkcs11KmsProviderStub(id = "pkcs11"): KmsProvider {
  const notImpl = (): Promise<never> =>
    Promise.reject(
      new Error(
        "kms/pkcs11: шов без реализации — подключите биндинг вашего HSM (C_WrapKey/C_UnwrapKey) " +
          "и зарегистрируйте провайдер под id 'pkcs11'.",
      ),
    );
  return { id, wrap: notImpl, unwrap: notImpl };
}
