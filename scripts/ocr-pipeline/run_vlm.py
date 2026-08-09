#!/usr/bin/env python3
"""Прогон OCR-VLM целой страницей.

  run_vlm.py <model_id> <out.jsonl> [--pages=a,b] [--maxpx=N] [--run=1] [--dpi=300]

Страница подаётся картинкой целиком: у VLM своя разметка, детектор строк не нужен.
Ограничиваем длинную сторону, иначе на 4293 px визуальный энкодер даёт десятки тысяч
токенов и на процессоре это часы.
"""
import glob
import json
import os
import sys
import time

import torch
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor

Image.MAX_IMAGE_PIXELS = None

# Родной промпт Rukopys — модель обучена отдавать JSON с областями, а не сплошной текст.
# Свой промпт ей давать нельзя: сломается формат, а с ним и качество.
RUKOPYS = ("Detect every text region in this Ukrainian handwritten document and return a JSON "
           "array of regions. Each region has bbox (x1 y1 x2 y2 in 0..1000 normalized image "
           "coordinates), type (handwritten | printed | formula | table | annotation | image | "
           "graph), and text (transcription; empty for image/graph; LaTeX for formula; "
           "pipe-separated for table).")
GENERIC = ("Распознай весь текст на этой странице, включая рукописные вставки в бланке. "
           "Выводи только текст, ничего не додумывай. Если поле пустое — пропусти его.")


def flatten(out):
    """Из JSON-массива областей достаём только транскрипции — вход для метрик."""
    import re as _re
    m = _re.search(r"\[.*\]", out, _re.S)
    if not m:
        return out
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return out
    return " ".join(str(r.get("text", "")) for r in arr if isinstance(r, dict))


def main():
    model_id, outp = sys.argv[1], sys.argv[2]
    pages, maxpx, dpi, run = None, 1600, "300", "1"
    for a in sys.argv[3:]:
        k, _, v = a.partition("=")
        if k == "--pages":
            pages = v.split(",")
        elif k == "--maxpx":
            maxpx = int(v)
        elif k == "--dpi":
            dpi = v
        elif k == "--run":
            run = v
    is_rukopys = "Rukopys" in model_id
    prompt = RUKOPYS if is_rukopys else GENERIC
    proc = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForImageTextToText.from_pretrained(
        model_id, dtype=torch.float32, low_cpu_mem_usage=True).eval()
    src = f"bench/img{dpi}"
    if pages is None:
        pages = sorted(os.path.basename(f)[:-4] for f in glob.glob(src + "/*.jpg"))
    res = []
    for pg in pages:
        im = Image.open(f"{src}/{pg}.jpg").convert("RGB")
        if max(im.size) > maxpx:
            s = maxpx / max(im.size)
            im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
        msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}]
        try:
            text = proc.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True,
                                            enable_thinking=False)
        except TypeError:
            text = proc.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inputs = proc(text=[text], images=[im], return_tensors="pt")
        t0 = time.time()
        with torch.no_grad():
            # no_repeat_ngram_size — против зацикливания на пустых ячейках таблицы:
            # без него модель печатает "| | | \n" до упора в лимит и теряет страницу целиком
            ids = model.generate(**inputs, max_new_tokens=3000, do_sample=False,
                                 no_repeat_ngram_size=12)
        raw = proc.batch_decode(ids[:, inputs["input_ids"].shape[1]:],
                                skip_special_tokens=True)[0]
        out = flatten(raw) if is_rukopys else raw
        dt = time.time() - t0
        res.append(dict(page=pg, text=out, sec=round(dt, 1), run=run))
        print(f"  {pg}: {dt:.0f} c, {len(out)} знаков", flush=True)
        with open(outp, "w") as f:
            for r in res:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    t = sum(r["sec"] for r in res)
    print(f"{model_id} cpu: {t:.0f} c на {len(res)} стр = {t/max(1,len(res)):.0f} c/стр")


if __name__ == "__main__":
    main()
