import { GOLD_CORPUS } from "../validation/gold";

const rows = GOLD_CORPUS.map((doc) =>
  JSON.stringify({
    id: doc.id,
    vertical: doc.vertical,
    text: doc.text,
    spans: doc.spans.map((span) => ({
      ...span,
      raw: doc.text.slice(span.start, span.end),
    })),
    quasi: doc.quasi,
  })
);
const output = process.argv[2];
if (output) {
  await Bun.write(output, `${rows.join("\n")}\n`);
} else {
  console.log(rows.join("\n"));
}
