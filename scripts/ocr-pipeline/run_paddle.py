#!/usr/bin/env python3
"""PaddleOCR-VL штатным конвейером: разбор страницы целиком (с таблицами).

Два режима входа, чтобы отделить вклад модели от вклада нашей предобработки:
  raw  — исходный скан (сравнение с опубликованными 42,6 %)
  hand — только рукописный слой после цветового разделения (сравнение с 60,9 %)
"""
import json, sys, time, os
from paddleocr import PaddleOCRVL
from inklayer import split

mode = sys.argv[1] if len(sys.argv)>1 else "raw"
outp = sys.argv[2] if len(sys.argv)>2 else f"out/paddle_{mode}.jsonl"
PAGES="p020_5 p020_17 p011_8 p002_2 p016_8 p011_22 p033_8 p009_8 p016_26 p033_14 p002_4 p039_26 p021_9 p004_2 p024_10".split()
pipe=PaddleOCRVL(pipeline_version="v1")
os.makedirs("tmpimg", exist_ok=True)
rows=[]
for pg in PAGES:
    src=f"bench/img300/{pg}.jpg"
    if mode=="hand":
        hand,_,_=split(src); src=f"tmpimg/{pg}.hand.png"; hand.save(src)
    t0=time.time()
    try:
        res=pipe.predict(src)
        parts=[]
        for r in res:
            d=r.json if hasattr(r,"json") else {}
            parts.append(json.dumps(d, ensure_ascii=False))
        txt=" ".join(parts)
    except Exception as e:
        txt=""; print(f"  {pg}: СБОЙ {e}", flush=True)
    dt=time.time()-t0
    rows.append(dict(page=pg, text=txt, sec=round(dt,1)))
    print(f"  {pg}: {dt:.1f} c, знаков {len(txt)}", flush=True)
with open(outp,"w") as f:
    for r in rows: f.write(json.dumps(r, ensure_ascii=False)+"\n")
print("готово", outp)
