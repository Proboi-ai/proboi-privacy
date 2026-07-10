export {};
/**
 * Мок privacy-сайдкара для тестов — говорит на том же JSON-newline протоколе,
 * что и настоящий Python-сайдкар, но без Python/Natasha.
 *
 * Запуск: bun src/__fixtures__/mock-sidecar.ts
 *   health → {ok:true}
 *   deid   → одна PER-сущность из первых 5 символов текста (доказывает, что params
 *            дошли и структурный result вернулся). CRASH-режим: env MOCK_CRASH=1 →
 *            процесс падает после первого запроса (проверка fail-closed).
 */

const decoder = new TextDecoder();
let buf = "";

function respond(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req: { id: number; method: string; params: { text?: string; types?: string[] } };
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.method === "health") {
      respond({ id: req.id, ok: true, result: { ok: true } });
    } else if (req.method === "deid") {
      const text = req.params?.text ?? "";
      const entities = text
        ? [{ type: "PER", raw: text.slice(0, 5), index: 0, confidence: "high" }]
        : [];
      respond({ id: req.id, ok: true, result: { entities } });
    } else {
      respond({ id: req.id, ok: false, error: `unknown method: ${req.method}` });
    }
    if (process.env.MOCK_CRASH === "1") process.exit(1);
  }
}
