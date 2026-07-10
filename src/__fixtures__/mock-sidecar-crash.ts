export {};
/**
 * Crash-вариант мок-сайдкара для теста fail-closed: отвечает на первый
 * запрос (health), затем немедленно падает — проверяем, что SidecarManager ловит
 * exit и переводит статус в 'down'.
 */

const decoder = new TextDecoder();
let buf = "";

for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk);
  const nl = buf.indexOf("\n");
  if (nl < 0) continue;
  const line = buf.slice(0, nl).trim();
  if (line) {
    const req = JSON.parse(line) as { id: number };
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + "\n");
  }
  process.exit(1); // упасть после первого ответа
}
