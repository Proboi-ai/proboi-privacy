#!/usr/bin/env python3
"""Наивный детектор строк проекцией — общий вход для всех построчных распознавателей.

Специально простой и одинаковый для всех моделей: сравниваем распознаватели,
а не детекторы. Работает на бланках (строки разделены белым), на разлинованных
таблицах заведомо хуже — это отдельно отмечено в отчёте.

  lines.py <page_id> [out_dir]
"""
import os
import sys

import numpy as np
from PIL import Image

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench", "img300")
Image.MAX_IMAGE_PIXELS = None


def deskew(a, limit=3.0, step=0.25):
    """Микро-выравнивание наклона по максимуму дисперсии горизонтальной проекции."""
    best, ang = None, 0.0
    small = np.array(Image.fromarray(a).resize((a.shape[1] // 4, a.shape[0] // 4)))
    for d in np.arange(-limit, limit + step, step):
        r = np.array(Image.fromarray(small).rotate(d, resample=Image.BILINEAR, fillcolor=255))
        p = (r < 160).sum(axis=1).astype(float)
        v = ((p[1:] - p[:-1]) ** 2).sum()
        if best is None or v > best:
            best, ang = v, d
    return ang


def segment(path, min_h=18, pad=8, do_deskew=True):
    im = Image.open(path).convert("L")
    a = np.array(im)
    ang = deskew(a) if do_deskew else 0.0
    if abs(ang) > 0.01:
        im = im.rotate(ang, resample=Image.BICUBIC, fillcolor=255)
        a = np.array(im)
    thr = max(110, int(np.percentile(a, 25)) - 10)
    ink = a < thr
    prof = ink.sum(axis=1)
    w = a.shape[1]
    # длинные горизонтальные линовки/подчёркивания глушим, иначе весь бланк — одна строка
    rows_full = prof > w * 0.55
    prof = np.where(rows_full, 0, prof)
    on = prof > max(3, w * 0.004)
    bands, s = [], None
    for i, v in enumerate(on):
        if v and s is None:
            s = i
        elif not v and s is not None:
            if i - s >= min_h:
                bands.append((s, i))
            s = None
    if s is not None and len(on) - s >= min_h:
        bands.append((s, len(on)))
    out = []
    for y0, y1 in bands:
        y0, y1 = max(0, y0 - pad), min(a.shape[0], y1 + pad)
        seg = ink[y0:y1]
        cols = seg.sum(axis=0) > 0
        idx = np.nonzero(cols)[0]
        if idx.size == 0:
            continue
        x0, x1 = max(0, idx[0] - pad), min(w, idx[-1] + pad)
        if x1 - x0 < 40:
            continue
        out.append((x0, y0, x1, y1))
    return im, out, ang


def main():
    page = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "linecrops"
    d = os.path.join(outdir, page)
    os.makedirs(d, exist_ok=True)
    im, boxes, ang = segment(os.path.join(SRC, page + ".jpg"))
    for i, b in enumerate(boxes):
        im.crop(b).save(os.path.join(d, f"{i:03d}.png"))
    print(f"{page}: строк {len(boxes)}, наклон {ang:+.2f}°")


if __name__ == "__main__":
    main()
