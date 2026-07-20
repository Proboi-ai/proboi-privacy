/**
 * Domain allow-list на shell-egress (флаг SHELL_EGRESS_ALLOWLIST).
 *
 * Defense-in-depth поверх text de-id egress-gate: блокирует shell-команды
 * (curl/wget/aria2c/Invoke-WebRequest/iwr/Invoke-RestMethod), уходящие к хостам НЕ
 * из allow-list — даже если де-ид выключен, данные физически не дойдут до untrusted host.
 *
 * Три режима (env SHELL_EGRESS_ALLOWLIST):
 *   off     (деф) — хук не ставится; поведение байт-в-байт прежнее.
 *   shadow  — если команда попала бы под блок, логируем и РАЗРЕШАЕМ (калибровка).
 *   enforce — ДЕНАИМ команду с человекочитаемой причиной ДО исполнения.
 *
 * Allow-list:
 *   Default: gateway + домены, используемые платформой (найдены по grep в исходниках).
 *   Env knob: SHELL_EGRESS_ALLOWLIST_HOSTS (запятая-разделённый список доп-хостов).
 *   Per-tenant: TODO — подключить через config-matrix (tenant overrides), когда full
 *   plumbing будет готов; пока оператор перекрывает через SHELL_EGRESS_ALLOWLIST_HOSTS.
 */

// ── Tri-state mode ────────────────────────────────────────────────────────────

export type ShellEgressMode = "off" | "shadow" | "enforce";

/**
 * Режим из env: off (деф) | shadow (только лог would-block) | enforce (реальный deny).
 * Идиома скопирована один-в-один с аналогичным tool-policy-переключателем движка.
 */
export function shellEgressMode(): ShellEgressMode {
  const v = (process.env.SHELL_EGRESS_ALLOWLIST ?? "off").toLowerCase();
  return v === "shadow" || v === "enforce" ? v : "off";
}

// ── Default allow-list ────────────────────────────────────────────────────────

/**
 * Дефолтный allow-list хостов.
 * Источники — реальные хосты, к которым обращается платформа (найдены grep-ом по исходникам):
 *   203.0.113.10      — центральный AI-шлюз (placeholder-IP: реальный prod-адрес не публикуется)
 *   google.serper.dev — Serper search API
 *   openrouter.ai     — OpenRouter LLM routing
 *   gate.joingonka.ai — Gonka LLM gateway
 *   api.deepseek.com  — DeepSeek
 *   proboi.site       — License API + HTTP-Referer в нескольких движках
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "203.0.113.10",
  "google.serper.dev",
  "openrouter.ai",
  "gate.joingonka.ai",
  "api.deepseek.com",
  "proboi.site",
];

/**
 * Строит effective allow-list: дефолт + env-override SHELL_EGRESS_ALLOWLIST_HOSTS.
 * @param overrideBase — для тестов: заменяет DEFAULT_ALLOWED_HOSTS целиком.
 */
export function buildAllowlist(overrideBase?: string[]): string[] {
  const fromEnv = (process.env.SHELL_EGRESS_ALLOWLIST_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const base = (overrideBase ?? DEFAULT_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  return Array.from(new Set([...base, ...fromEnv]));
}

// ── Host extraction ───────────────────────────────────────────────────────────

/**
 * Дешёвый pre-check: есть ли в команде хоть один network-verb.
 * Если нет — не инспектируем вовсе (нет overhead на нормальные команды).
 */
const SHELL_NETWORK_VERB_RE =
  /\b(curl|wget|aria2c|Invoke-WebRequest|iwr|Invoke-RestMethod|Invoke-Expression)\b/i;

/** Извлечение хостов из http(s)-URL внутри команды. */
const URL_HOST_RE = /https?:\/\/([^/\s"'`?#;:|\\>]+)/gi;

/**
 * Паттерн для PowerShell-команд без протокола: iwr/Invoke-WebRequest/Invoke-RestMethod.
 * Покрывает: `iwr evil.com`, `Invoke-WebRequest evil.com`, `-Uri evil.com` без `http`.
 * Не захватывает строки с `://` (они уже покрыты URL_HOST_RE).
 */
const IWR_NO_PROTO_RE =
  /(?:Invoke-WebRequest|iwr|Invoke-RestMethod)\s+(?:-Uri\s+)?['"]?(?!https?:\/\/)([A-Za-z0-9][A-Za-z0-9._-]{2,}(?:\.[A-Za-z]{2,})[^'"\s]*)['"]?/gi;

function normalizeHost(raw: string): string {
  // убираем порт и нормализуем регистр
  return raw.replace(/:\d+$/, "").toLowerCase().trim();
}

/**
 * Извлекает сетевые хосты из shell-команды.
 *
 * Возвращает null  — если команда НЕ содержит network verb (инспекция не нужна).
 * Возвращает []    — если verb есть, но явных хостов не распознано (пропускаем — консервативно).
 * Возвращает [...] — список нормализованных хостов для проверки.
 *
 * KNOWN LIMITATIONS (вынесены для ревью):
 *   1. Base64-обёртки (`echo ... | base64 -d | bash`) — verb виден только внутри
 *      декодированной строки; блок НЕ сработает.
 *   2. Переменные (`curl $URL`) — хост неизвестен в parse time; блок НЕ сработает.
 *   3. `Invoke-Expression` / `iex` — алиас eval; исполняет произвольную строку; мы
 *      замечаем verb-присутствие, но хост может быть скрыт. Логируем присутствие verb
 *      и пропускаем в shadow; в enforce деним команды с явным хостом.
 *   4. Heredoc и многострочные команды — извлечение работает построчно через RE, но
 *      неполные случаи могут пропускаться.
 */
export function extractNetworkTargets(command: string): string[] | null {
  if (!SHELL_NETWORK_VERB_RE.test(command)) return null;

  const hosts: string[] = [];

  URL_HOST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_HOST_RE.exec(command)) !== null) {
    if (m[1]) hosts.push(normalizeHost(m[1]));
  }

  IWR_NO_PROTO_RE.lastIndex = 0;
  while ((m = IWR_NO_PROTO_RE.exec(command)) !== null) {
    if (m[1]) hosts.push(normalizeHost(m[1]));
  }

  // дедупликация (команда может несколько раз ссылаться на один хост)
  return Array.from(new Set(hosts));
}

// ── Allow-list check ──────────────────────────────────────────────────────────

export interface EgressCheckResult {
  /** null → разрешено; непустая строка → первый заблокированный хост */
  blockedHost: string | null;
}

/**
 * Проверяет, разрешён ли хост allow-list-ом.
 * Матч: точное совпадение ИЛИ allowedHost является суффиксом домена
 *   (т.е. "proboi.site" покрывает "app.proboi.site").
 */
function isHostAllowed(host: string, allowlist: string[]): boolean {
  const h = normalizeHost(host);
  for (const entry of allowlist) {
    if (h === entry || h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Главная точка входа: проверяет команду против allow-list.
 *
 * @param command   — текст shell-команды
 * @param allowlist — injectable для тестов; если undefined — buildAllowlist()
 *
 * Возвращает { blockedHost: null } если команда разрешена или не содержит network verb.
 * Возвращает { blockedHost: host } если нашёлся хост вне allow-list.
 *
 * Никогда не бросает — любой parse error = разрешаем (fail-open на уровне парсера,
 * но только для этой функции; deny/allow-решение принимает вызывающий по egressMode).
 */
export function checkShellEgress(
  command: string,
  allowlist?: string[],
): EgressCheckResult {
  try {
    const targets = extractNetworkTargets(command);
    if (targets === null) return { blockedHost: null }; // нет verb — не трогаем

    const list = allowlist ?? buildAllowlist();

    for (const host of targets) {
      if (!isHostAllowed(host, list)) {
        return { blockedHost: host };
      }
    }

    return { blockedHost: null };
  } catch {
    // malformed command — не роняем хук (fail-open на parse; deny — только при явном хосте вне list)
    return { blockedHost: null };
  }
}
