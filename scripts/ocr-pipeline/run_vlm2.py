#!/usr/bin/env python3
"""Прогон документных VLM (PaddleOCR-VL и подобных) по ТЕМ ЖЕ чистым кропам-значениям.

Важно для сравнимости: кропы берутся тем же values.extract, эталон и счётчик те же,
что дали 60,9 % у Kansallisarkisto. Меняется только распознаватель — иначе цифры
сравнивать нельзя.

PaddleOCR-VL через transformers умеет распознавание отдельных элементов, а не
разбор страницы целиком. Нам это и нужно: элементы у нас уже вырезаны цветовым
разделением. Полный разбор страницы (с таблицами) требует их собственного пакета —
это отдельный шаг, здесь не он.

  run_vlm2.py <model_id> <out_prefix> [--pages=a,b] [--prompt=OCR:]
"""
import json
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoProcessor

from values import extract

DEV = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.bfloat16 if DEV == "cuda" else torch.float32
PAGES = ("p020_5 p020_17 p011_8 p002_2 p016_8 p011_22 p033_8 p009_8 p016_26 "
         "p033_14 p002_4 p039_26 p021_9 p004_2 p024_10").split()


@torch.no_grad()
def rec_one(model, proc, im, prompt):
    msgs = [{"role": "user", "content": [{"type": "image", "image": im},
                                         {"type": "text", "text": prompt}]}]
    inp = proc.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                   return_dict=True, return_tensors="pt").to(DEV)
    out = model.generate(**inp, max_new_tokens=48, do_sample=False)
    txt = proc.batch_decode(out, skip_special_tokens=True)[0]
    # у чат-моделей в выводе часто остаётся эхо запроса — отрезаем по последней метке
    for marker in ("assistant", "OCR:", "\n"):
        if marker in txt:
            txt = txt.split(marker)[-1]
    return txt.strip()


def main():
    mid, prefix = sys.argv[1], sys.argv[2]
    pages, prompt = PAGES, "OCR:"
    for a in sys.argv[3:]:
        if a.startswith("--pages="):
            pages = a.split("=")[1].split(",")
        if a.startswith("--prompt="):
            prompt = a.split("=", 1)[1]

    proc = AutoProcessor.from_pretrained(mid, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        mid, trust_remote_code=True, torch_dtype=DTYPE).to(DEV).eval()

    prow, vrow = [], []
    T = 0.0
    for pg in pages:
        t0 = time.time()
        vals, _meta = extract(f"bench/img300/{pg}.jpg")
        texts = []
        for c in vals:
            try:
                t = rec_one(model, proc, c["crop"].convert("RGB"), prompt)
            except Exception as e:
                t = ""
                print(f"    сбой на кропе: {e}", flush=True)
            texts.append(t)
            vrow.append(dict(page=pg, box=[int(x) for x in c["box"]],
                             px=int(c["px"]), text=t))
        dt = time.time() - t0
        T += dt
        prow.append(dict(page=pg, text=" ".join(texts), sec=round(dt, 1)))
        print(f"  {pg}: {dt:.1f} c, значений {len(vals)}", flush=True)
    with open(prefix + ".jsonl", "w") as f:
        for r in prow:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(prefix + ".values.jsonl", "w") as f:
        for r in vrow:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"{mid} [vlm] {DEV}: {T:.1f} c на {len(prow)} стр = {T/max(1,len(prow)):.1f} c/стр")


if __name__ == "__main__":
    main()
