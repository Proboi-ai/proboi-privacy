#!/usr/bin/env python3
"""Прогон построчных распознавателей С СОХРАНЕНИЕМ УВЕРЕННОСТИ И ПРИЗНАКОВ КРОПА.

Отличие от run_trocr.py (замер 06.08): та же сегментация и тот же режим word —
цифры остаются сравнимы, — но на каждое слово дополнительно пишем:
  conf_mean  средняя вероятность токена (нормированная по длине)
  conf_min   вероятность самого неуверенного токена — ловит одну сомнительную цифру
             в остальном уверенной строке
  ink        доля чернил в кропе, число столбцовых штрихов, размеры
Без этих полей верификатор построить нельзя: модель всегда что-то печатает,
и отличить «прочитал» от «придумал» можно только по её же уверенности,
по согласию с другой моделью и по тому, было ли на кропе вообще что читать.

  run_trocr2.py <model_id> <out_prefix> [--seg=word|line] [--pages=a,b] [--limit=N]

Пишет два файла:
  <out_prefix>.jsonl       постранично {page,text,sec} — вход для старого score.py
  <out_prefix>.words.jsonl пословно {page,crop,idx,box,text,conf_mean,conf_min,ink...}
"""
import glob
import json
import os
import sys
import time

import numpy as np
import torch
from PIL import Image
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

DEV = "mps" if torch.backends.mps.is_available() else "cpu"


def word_boxes(im, gap_frac=0.022, min_w=14):
    """Та же нарезка по пробелам, что в замере 06.08 — не меняем, иначе цифры несравнимы."""
    a = np.array(im.convert("L"))
    ink = a < max(110, int(np.percentile(a, 25)) - 10)
    cols = ink.sum(axis=0) > 0
    gap = max(6, int(im.width * gap_frac))
    out, s, run = [], None, 0
    for i, v in enumerate(cols):
        if v:
            if s is None:
                s = i
            run = 0
        else:
            if s is not None:
                run += 1
                if run >= gap:
                    if i - run - s >= min_w:
                        out.append((s, i - run))
                    s = None
    if s is not None and len(cols) - s >= min_w:
        out.append((s, len(cols)))
    return out


def ink_features(im):
    """Что было на кропе ДО декодера. Пустой кроп — главный источник выдумок:
    модели нечего читать, а промолчать она не умеет и печатает заученное."""
    a = np.array(im.convert("L"))
    thr = max(110, int(np.percentile(a, 25)) - 10)
    ink = a < thr
    frac = float(ink.mean())
    cols = ink.sum(axis=0) > 0
    runs = int(np.sum(np.diff(cols.astype(np.int8)) == 1) + (1 if cols.size and cols[0] else 0))
    rows = ink.sum(axis=1)
    # длинная горизонтальная линовка: строка, закрашенная более чем наполовину
    ruled = int(np.sum(rows > ink.shape[1] * 0.55))
    return dict(ink=round(frac, 5), runs=runs, ruled=ruled,
                w=int(im.width), h=int(im.height))


@torch.no_grad()
def recognise(model, proc, batch):
    """Возвращает (тексты, conf_mean, conf_min). Жадное декодирование — воспроизводимо."""
    px = proc(images=batch, return_tensors="pt").pixel_values.to(DEV)
    out = model.generate(px, max_new_tokens=48, num_beams=1,
                         output_scores=True, return_dict_in_generate=True)
    texts = proc.batch_decode(out.sequences, skip_special_tokens=True)
    tr = model.compute_transition_scores(out.sequences, out.scores, normalize_logits=True)
    probs = tr.exp().float().cpu().numpy()
    # маска реальных токенов: -inf там, где генерация уже кончилась
    valid = np.isfinite(tr.float().cpu().numpy())
    means, mins = [], []
    for i in range(probs.shape[0]):
        p = probs[i][valid[i]]
        # последний токен — конец последовательности, он всегда уверенный, не считаем
        p = p[:-1] if p.size > 1 else p
        means.append(float(p.mean()) if p.size else 0.0)
        mins.append(float(p.min()) if p.size else 0.0)
    return texts, means, mins


def main():
    model_id = sys.argv[1]
    prefix = sys.argv[2]
    seg, pages, limit = "word", None, None
    for a in sys.argv[3:]:
        if a.startswith("--seg="):
            seg = a.split("=")[1]
        if a.startswith("--pages="):
            pages = a.split("=")[1].split(",")
        if a.startswith("--limit="):
            limit = int(a.split("=")[1])

    proc = TrOCRProcessor.from_pretrained(model_id)
    model = VisionEncoderDecoderModel.from_pretrained(model_id).to(DEV).eval()

    dirs = sorted(glob.glob("linecrops/*"))
    if pages:
        dirs = [d for d in dirs if os.path.basename(d) in pages]
    if limit:
        dirs = dirs[:limit]

    page_rows, word_rows = [], []
    t_all = 0.0
    for d in dirs:
        page = os.path.basename(d)
        t0 = time.time()
        texts_page = []
        items = []            # (crop_name, idx, box, PIL, ink)
        for f in sorted(glob.glob(d + "/*.png")):
            im = Image.open(f).convert("RGB")
            if seg == "word":
                bx = word_boxes(im)
                pieces = [(i, (x0, 0, x1, im.height), im.crop((x0, 0, x1, im.height)))
                          for i, (x0, x1) in enumerate(bx)] or \
                         [(0, (0, 0, im.width, im.height), im)]
            else:
                pieces = [(0, (0, 0, im.width, im.height), im)]
            for idx, box, sub in pieces:
                items.append((os.path.basename(f), idx, box, sub, ink_features(sub)))

        for i in range(0, len(items), 8):
            chunk = items[i:i + 8]
            texts, cmean, cmin = recognise(model, proc, [c[3] for c in chunk])
            for (crop, idx, box, _sub, ink), t, cm, ci in zip(chunk, texts, cmean, cmin):
                texts_page.append(t)
                word_rows.append(dict(page=page, crop=crop, idx=idx, box=list(box),
                                      text=t, conf_mean=round(cm, 4), conf_min=round(ci, 4),
                                      **ink))
        dt = time.time() - t0
        t_all += dt
        page_rows.append(dict(page=page, text=" ".join(texts_page), sec=round(dt, 1)))
        print(f"  {page}: {dt:.1f} c, фрагментов {len(items)}", flush=True)

    with open(prefix + ".jsonl", "w") as f:
        for r in page_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(prefix + ".words.jsonl", "w") as f:
        for r in word_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    n = max(1, len(page_rows))
    print(f"{model_id} [{seg}] {DEV}: {t_all:.1f} c на {len(page_rows)} стр = {t_all/n:.1f} c/стр")


if __name__ == "__main__":
    main()
