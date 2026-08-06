#!/usr/bin/env python3
"""Строит наблюдения {doc_id, found} для bootstrap_ci.py из вывода score.ts (*-gold.json)
и файла кусков (chunks-fresh2.jsonl, chunk_id -> doc_id).

Использование:
  python3 build-obs.py <score-fresh2-gold.json> <chunks-fresh2.jsonl> <outdir>

Пишет outdir/obs-WELL.jsonl, outdir/obs-GEO_NAME.jsonl, outdir/obs-LICENSE_SUBSOIL.jsonl.
Единица наблюдения — ОДИН эталонный спан (found: true/false), doc_id — ПОЛНЫЙ (corpus:doc_id),
чтобы документы с одинаковым именем из разных корпусов (docx/pdf) не схлопывались в один.
"""
import json, sys, os

gold_path, chunks_path, outdir = sys.argv[1], sys.argv[2], sys.argv[3]

chunk_doc = {}
with open(chunks_path, encoding="utf-8") as f:
    for line in f:
        if not line.strip():
            continue
        c = json.loads(line)
        chunk_doc[c["chunk_id"]] = f'{c["corpus"]}:{c["doc_id"]}'

gold = json.load(open(gold_path, encoding="utf-8"))
os.makedirs(outdir, exist_ok=True)
by_type = {}
missing_doc = 0
for g in gold:
    doc_id = chunk_doc.get(g.get("chunk_id"))
    if not doc_id:
        missing_doc += 1
        continue
    t = g["type"]
    by_type.setdefault(t, []).append({"doc_id": doc_id, "found": bool(g["found"])})

for t, rows in by_type.items():
    outp = os.path.join(outdir, f"obs-{t}.jsonl")
    with open(outp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    docs = len(set(r["doc_id"] for r in rows))
    hits = sum(r["found"] for r in rows)
    print(f"{t}: {len(rows)} спанов, {docs} документов, найдено {hits} ({100*hits/len(rows):.1f}%) -> {outp}")

if missing_doc:
    print(f"ВНИМАНИЕ: {missing_doc} записей gold без соответствия chunk_id->doc_id (пропущены)")
