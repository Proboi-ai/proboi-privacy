#!/usr/bin/env python3
"""Из выгрузки dump-spans собрать ЛОЖНЫЕ находки детектора в формате items для precision.ts.

Зачем. Точность в замерах связки считается ПЕРЕКРЫТИЕМ С РАЗМЕТКОЙ: находка, которой в эталоне
нет, автоматически объявляется ложной. Но разметка сама неполна — и тогда «ложняк» может
оказаться пропуском разметчика. Единственный способ отличить одно от другого — спросить
НЕЗАВИСИМОГО судью, который не видит ни эталона, ни наших правил (`precision.ts --phase judge`).

    python3 scripts/geo-coord/fp-items.py .work/geo-fix/spans-fresh2-cv.jsonl \
        --type COORD --corpus client-fresh2-pdf --out .work/geo-gold/precision-items-fp.jsonl
"""
import argparse
import json

ap = argparse.ArgumentParser()
ap.add_argument("spans")
ap.add_argument("--type", default="COORD")
ap.add_argument("--out", required=True)
ap.add_argument("--tag", default="fp")
a = ap.parse_args()

def ctx(text: str, start: int, end: int, radius: int) -> str:
    """±radius знаков вокруг находки, сама находка отмечена ⟦…⟧ — как в precision.ts."""
    left, right = max(0, start - radius), min(len(text), end + radius)
    s = text[left:start] + "⟦" + text[start:end] + "⟧" + text[end:right]
    return " ".join(s.split())


out = []
for line in open(a.spans, encoding="utf8"):
    line = line.strip()
    if not line:
        continue
    row = json.loads(line)
    text = row["text"]
    gold = [g for g in row["gold"] if g["type"] == a.type]
    rules = [r for r in row["rules"] if r["type"] == a.type]
    for r in rules:
        # «мягкое» сопоставление eval_verifier: пересечение спанов
        if any(g["start"] < r["end"] and r["start"] < g["end"] for g in gold):
            continue
        s, e = max(0, r["start"]), min(len(text), r["end"])
        out.append({
            "id": f"{a.tag}:{a.type}:{row['corpus']}:{row['doc_id']}:{r['start']}:{r['end']}",
            "kind": "real",
            "type": a.type,
            "corpus": row["corpus"],
            "doc_id": row["doc_id"],
            "value": r["raw"],
            "start": s,
            "end": e,
            "ctx400": ctx(text, s, e, 400),
            "ctx200": ctx(text, s, e, 200),
        })

with open(a.out, "w", encoding="utf8") as f:
    for it in out:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
print(f"находок без эталона: {len(out)} → {a.out}")
