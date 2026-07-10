/**
 * SidecarManager — жизненный цикл Python privacy-сайдкара.
 *
 * Реальный запуск через Bun.spawn (НЕ Worker — грабля compiled-exe).
 * Протокол: JSON-newline по stdin/stdout.
 *   запрос:  {"id":N,"method":"health|deid","params":{...}}\n
 *   ответ:   {"id":N,"ok":true,"result":{...}}\n | {"id":N,"ok":false,"error":"..."}\n
 *
 * Fail-closed: процесс не поднялся/упал → статус 'down', pending-запросы
 * отклоняются. Компоненты, зависящие от сайдкара, при 'down' блокируют egress —
 * приватность > доступность (решает pipeline/available()).
 *
 * Команда берётся из PRIVACY_SIDECAR_CMD либо из аргумента конструктора (тесты).
 */

import type { FileSink } from "bun";
import { PRIVACY_SIDECAR_CMD } from "./config";
import type { DetectedEntity, EntityType } from "./deid/detect";

export type SidecarStatus = "absent" | "healthy" | "down";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseCmd(raw: string): string[] {
  return raw.trim() ? raw.trim().split(/\s+/) : [];
}

export class SidecarManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private _status: SidecarStatus;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private cmd: string[];

  constructor(cmd?: string[]) {
    this.cmd = cmd ?? parseCmd(PRIVACY_SIDECAR_CMD);
    this._status = this.cmd.length ? "down" : "absent";
  }

  /** Синхронный кэшированный статус. */
  status(): SidecarStatus {
    return this._status;
  }

  /** Поднимает сайдкар и проверяет health. Идемпотентно если уже жив. */
  async start(): Promise<void> {
    if (!this.cmd.length) {
      this._status = "absent";
      return;
    }
    if (this.proc) return;
    this.proc = Bun.spawn(this.cmd, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    void this.readLoop(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.proc.exited.then(() => {
      this.proc = null;
      this._status = "down";
      this.rejectAll("сайдкар завершился");
    });
    this._status = (await this.pingHealth()) ? "healthy" : "down";
  }

  /** Async health-пинг: обновляет и возвращает статус. */
  async health(): Promise<SidecarStatus> {
    if (!this.cmd.length) return (this._status = "absent");
    if (!this.proc) return (this._status = "down");
    this._status = (await this.pingHealth()) ? "healthy" : "down";
    return this._status;
  }

  /** Upgrade: высокорекольная де-ид через сайдкар (Natasha). */
  async deid(text: string, types: EntityType[]): Promise<DetectedEntity[]> {
    const r = (await this.request("deid", { text, types })) as { entities?: DetectedEntity[] };
    return r.entities ?? [];
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (p) {
      try {
        (p.stdin as FileSink).end();
      } catch {
        /* already closed */
      }
      p.kill();
      await p.exited.catch(() => {});
    }
    this.rejectAll("сайдкар остановлен");
    if (this.cmd.length) this._status = "down";
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // --- внутреннее ---

  private async pingHealth(): Promise<boolean> {
    try {
      await this.request("health", {}, 3000);
      return true;
    } catch {
      return false;
    }
  }

  private request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error("сайдкар не запущен"));
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + "\n";
    const sink = this.proc.stdin as FileSink;
    sink.write(line);
    sink.flush();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`таймаут сайдкара (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private async readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.dispatch(line);
        }
      }
    } catch {
      /* поток закрыт — exited-хэндлер разрулит статус */
    }
  }

  private dispatch(line: string): void {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // не-JSON строки (напр. случайный вывод) игнорируем
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "ошибка сайдкара"));
  }

  private rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
