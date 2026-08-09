#!/usr/bin/env python3
"""Привязка рукописных значений к местам заполнения бланка («слотам»).

Зачем нужно, если значения уже вырезаны. Группировка по близости не знает, где
кончается одно поле и начинается другое: дата «07.04.2021» разваливается на три
острова, а два соседних поля на одной строке («от линии № 18   вниз 600») наоборот
рискуют слипнуться. Ответ даёт сам бланк: каждое заполняемое место — это
горизонтальная линовка в ПЕЧАТНОМ слое, и значение лежит прямо над своей линовкой.

Так мы получаем не «острова чернил», а «поля» — и вместе с ними право применить
доменный верификатор, которому нужно имя поля, а не просто число.

Линовку ищем в печатном слое, чтобы подчёркивания не мешали: рукопись оттуда уже
вычтена цветом.
"""
import numpy as np
from PIL import Image

from inklayer import split
from values import components, group


def rulings(printed, min_frac=0.035, max_h=6, merge_gap=25):
    """Горизонтальные линовки: длинные тонкие полосы чернил в печатном слое."""
    a = np.asarray(printed) < 128
    H, W = a.shape
    min_w = int(W * min_frac)
    segs = []
    for y in range(H):
        row = a[y]
        if row.sum() < min_w:
            continue
        xs = np.nonzero(row)[0]
        # непрерывные пробеги по x с допуском на разрывы
        start = prev = xs[0]
        for x in xs[1:]:
            if x - prev > merge_gap:
                if prev - start >= min_w:
                    segs.append([start, y, prev, y])
                start = x
            prev = x
        if prev - start >= min_w:
            segs.append([start, y, prev, y])
    # склеить полосы соседних строк в одну линовку
    segs.sort(key=lambda s: (s[1], s[0]))
    out = []
    for s in segs:
        hit = None
        for t in out:
            if abs(s[1] - t[3]) <= max_h and not (s[2] < t[0] - merge_gap or s[0] > t[2] + merge_gap):
                hit = t
                break
        if hit:
            hit[0] = min(hit[0], s[0]); hit[2] = max(hit[2], s[2]); hit[3] = max(hit[3], s[1])
        else:
            out.append(list(s))
    return [tuple(s) for s in out]


def attach(path, below=12, pad=12, min_px=12, split_gap=90):
    """→ список слотов: {rule, box, crop, parts}. Значение = чернила над линовкой.

    Высота окна поиска берётся от самих чернил (медианная высота компоненты), а не
    фиксированным числом: жёсткие 95 px на 300 DPI захватывали строку выше.
    Внутри слота значения разделяются по большому разрыву — так «07 04 2021»
    (промежутки мелкие) остаётся одной датой, а «14°» и «6», стоящие на общей
    линовке далеко друг от друга, расходятся на два поля.
    """
    hand, printed, meta = split(path)
    ha = np.asarray(hand) < 128
    H, W = ha.shape
    rules = rulings(printed)
    boxes = components(ha, min_px=min_px)
    hs = sorted(b[3] - b[1] for b in boxes) or [40]
    above = int(1.9 * hs[len(hs) // 2])          # ≈ две высоты цифры
    used = set()
    slots = []
    for (rx0, ry0, rx1, ry1) in rules:
        members = []
        for i, b in enumerate(boxes):
            if i in used:
                continue
            cx = (b[0] + b[2]) / 2
            # центр по x внутри линовки, низ знака — над линовкой, но не слишком высоко
            if rx0 - 8 <= cx <= rx1 + 8 and (ry0 - above) <= b[3] <= (ry0 + below):
                members.append((i, b))
        if not members:
            continue
        for i, _ in members:
            used.add(i)
        members.sort(key=lambda m: m[1][0])
        chunks, cur = [], [members[0]]
        for prev, nxt in zip(members, members[1:]):
            if nxt[1][0] - prev[1][2] > split_gap:
                chunks.append(cur); cur = [nxt]
            else:
                cur.append(nxt)
        chunks.append(cur)
        for ch in chunks:
            xs0 = min(b[0] for _, b in ch); ys0 = min(b[1] for _, b in ch)
            xs1 = max(b[2] for _, b in ch); ys1 = max(b[3] for _, b in ch)
            x0, y0 = max(0, xs0 - pad), max(0, ys0 - pad)
            x1, y1 = min(W, xs1 + pad), min(H, ys1 + pad)
            if x1 - x0 < 16 or y1 - y0 < 14:
                continue
            slots.append(dict(rule=(rx0, ry0, rx1, ry1), box=(x0, y0, x1, y1),
                              parts=len(ch), px=sum(b[4] for _, b in ch),
                              crop=hand.crop((x0, y0, x1, y1))))
    # чернила, не попавшие ни на одну линовку (таблицы, пометки на полях)
    orphan = [b for i, b in enumerate(boxes) if i not in used]
    og = [g for g in group(orphan) if g["n"] >= 40]
    slots.sort(key=lambda s: (s["box"][1], s["box"][0]))
    return slots, og, rules, meta


if __name__ == "__main__":
    import os
    import sys
    for p in sys.argv[1:]:
        name = os.path.basename(p).rsplit(".", 1)[0]
        sl, orph, rules, meta = attach(p)
        d = f"slotcrops/{name}"
        os.makedirs(d, exist_ok=True)
        for i, s in enumerate(sl):
            s["crop"].save(f"{d}/{i:03d}.png")
        print(f"{name}: линовок {len(rules)}, слотов с чернилами {len(sl)}, "
              f"вне линовок {len(orph)}")
