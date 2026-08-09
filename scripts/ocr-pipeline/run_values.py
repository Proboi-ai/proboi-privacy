#!/usr/bin/env python3
"""Распознавание ЧИСТЫХ кропов-значений (цветовое разделение + группировка).

Вход — не строки бланка, а отдельные значения на белом: ни линовки, ни печатных
подписей. Пишем уверенность, как и в run_trocr2.py, — она нужна верификатору.

  run_values.py <model_id> <out_prefix> [--pages=a,b]
"""
import glob, json, os, sys, time
import numpy as np, torch
from PIL import Image
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from values import extract

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
PAGES = "p020_5 p020_17 p011_8 p002_2 p016_8 p011_22 p033_8 p009_8 p016_26 p033_14 p002_4 p039_26 p021_9 p004_2 p024_10".split()

@torch.no_grad()
def rec(model, proc, ims):
    px = proc(images=ims, return_tensors="pt").pixel_values.to(DEV)
    o = model.generate(px, max_new_tokens=32, num_beams=1,
                       output_scores=True, return_dict_in_generate=True)
    txt = proc.batch_decode(o.sequences, skip_special_tokens=True)
    tr = model.compute_transition_scores(o.sequences, o.scores, normalize_logits=True)
    t = tr.float().cpu().numpy(); p = np.exp(t); ok = np.isfinite(t)
    cm, ci = [], []
    for i in range(p.shape[0]):
        v = p[i][ok[i]]; v = v[:-1] if v.size > 1 else v
        cm.append(float(v.mean()) if v.size else 0.0); ci.append(float(v.min()) if v.size else 0.0)
    return txt, cm, ci

def main():
    mid, prefix = sys.argv[1], sys.argv[2]
    pages = PAGES
    for a in sys.argv[3:]:
        if a.startswith("--pages="): pages = a.split("=")[1].split(",")
    proc = TrOCRProcessor.from_pretrained(mid)
    model = VisionEncoderDecoderModel.from_pretrained(mid).to(DEV).eval()
    prow, vrow = [], []
    T = 0.0
    for pg in pages:
        t0 = time.time()
        vals, meta = extract(f"bench/img300/{pg}.jpg")
        texts = []
        for i in range(0, len(vals), 8):
            ch = vals[i:i+8]
            tx, cm, ci = rec(model, proc, [c["crop"].convert("RGB") for c in ch])
            for c, t, a, b in zip(ch, tx, cm, ci):
                texts.append(t)
                vrow.append(dict(page=pg, box=list(c["box"]), px=c["px"], text=t,
                                 conf_mean=round(a,4), conf_min=round(b,4)))
        dt = time.time()-t0; T += dt
        prow.append(dict(page=pg, text=" ".join(texts), sec=round(dt,1)))
        print(f"  {pg}: {dt:.1f} c, значений {len(vals)}", flush=True)
    with open(prefix+".jsonl","w") as f:
        for r in prow: f.write(json.dumps(r, ensure_ascii=False)+"\n")
    with open(prefix+".values.jsonl","w") as f:
        for r in vrow: f.write(json.dumps(r, ensure_ascii=False)+"\n")
    print(f"{mid} [values] {DEV}: {T:.1f} c на {len(prow)} стр = {T/max(1,len(prow)):.1f} c/стр")

if __name__ == "__main__":
    main()
