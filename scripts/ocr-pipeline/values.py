#!/usr/bin/env python3
"""Выделение отдельных рукописных ЗНАЧЕНИЙ из очищенного слоя.

Когда печать и линовка убраны (inklayer.split), значения на бланке перестают быть
частью строки и становятся отдельными островами чернил. Поэтому здесь не нужна
ни нарезка строки по пробелам «на глаз», ни угадывание ширины пробела: группируем
связные компоненты по близости и получаем ровно то, что человек назвал бы
«одно заполненное поле».

Это важнее выбора модели. Замер 06.08 показал: главный прирост дала подача кропа
в родном масштабе (строка целиком → слова: выдумок 14 → 3-4). Здесь масштаб родной
по построению, а вокруг значения нет ни линовки, ни печатных подписей — то есть
нет и повода достраивать «правдоподобный текст» к нечитаемому мылу.

Связные компоненты считаем сами (BFS по маске), чтобы не тащить scipy.
"""
import numpy as np
from PIL import Image

from inklayer import split


def components(mask, min_px=12):
    """Связные компоненты (8-связность) итеративно, без рекурсии и без scipy."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    boxes = []
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        cur += 1
        stack = [(y0, x0)]
        lab[y0, x0] = cur
        miny = maxy = y0
        minx = maxx = x0
        n = 0
        while stack:
            y, x = stack.pop()
            n += 1
            if y < miny: miny = y
            if y > maxy: maxy = y
            if x < minx: minx = x
            if x > maxx: maxx = x
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cur
                        stack.append((ny, nx))
        if n >= min_px:
            # int() обязателен: индексы приходят из np.nonzero как numpy.int64,
            # а json.dumps их не сериализует — на этом молча терялся весь дамп
            # уверенности (файл открывался и падал на первой записи).
            boxes.append((int(minx), int(miny), int(maxx) + 1, int(maxy) + 1, int(n)))
    return boxes


def group(boxes, gap_x=55, gap_y_frac=0.6):
    """Слить соседние компоненты в значение: цифры одного числа стоят рядом
    и на одной строке. gap_x в пикселях 300 DPI ≈ 4,6 мм."""
    if not boxes:
        return []
    items = sorted(boxes, key=lambda b: (b[1] // 40, b[0]))
    groups = []
    for b in items:
        placed = False
        for g in groups:
            gx0, gy0, gx1, gy1 = g["box"]
            hh = max(gy1 - gy0, b[3] - b[1])
            # «та же строка» = вертикальные проекции перекрываются заметной долей высоты
            same_row = min(gy1, b[3]) - max(gy0, b[1]) > hh * gap_y_frac * 0.5
            near_x = b[0] - gx1 <= gap_x and gx0 - b[2] <= gap_x
            if same_row and near_x:
                g["box"] = (min(gx0, b[0]), min(gy0, b[1]), max(gx1, b[2]), max(gy1, b[3]))
                g["n"] += b[4]
                placed = True
                break
        if not placed:
            groups.append(dict(box=(b[0], b[1], b[2], b[3]), n=b[4]))
    # второй проход: слить группы, ставшие соседями после роста
    changed = True
    while changed:
        changed = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, b = groups[i]["box"], groups[j]["box"]
                hh = max(a[3] - a[1], b[3] - b[1])
                same_row = min(a[3], b[3]) - max(a[1], b[1]) > hh * 0.35
                near = (b[0] - a[2] <= gap_x) and (a[0] - b[2] <= gap_x)
                if same_row and near:
                    groups[i]["box"] = (min(a[0], b[0]), min(a[1], b[1]),
                                        max(a[2], b[2]), max(a[3], b[3]))
                    groups[i]["n"] += groups[j]["n"]
                    groups.pop(j)
                    changed = True
                    break
            if changed:
                break
    return groups


def extract(path, pad=14, min_px=12, min_group_px=40):
    hand, printed, meta = split(path)
    a = np.asarray(hand)
    mask = a < 128
    boxes = components(mask, min_px=min_px)
    gs = [g for g in group(boxes) if g["n"] >= min_group_px]
    H, W = a.shape
    out = []
    for g in gs:
        x0, y0, x1, y1 = g["box"]
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(W, x1 + pad), min(H, y1 + pad)
        if x1 - x0 < 16 or y1 - y0 < 16:
            continue
        out.append(dict(box=(x0, y0, x1, y1), px=g["n"],
                        inkbox=tuple(g["box"]), crop=hand.crop((x0, y0, x1, y1))))
    out.sort(key=lambda d: (d["box"][1], d["box"][0]))
    return out, meta


if __name__ == "__main__":
    import os
    import sys
    for p in sys.argv[1:]:
        name = os.path.basename(p).rsplit(".", 1)[0]
        vals, meta = extract(p)
        d = f"valcrops/{name}"
        os.makedirs(d, exist_ok=True)
        for i, v in enumerate(vals):
            v["crop"].save(f"{d}/{i:03d}.png")
        print(f"{name}: значений {len(vals)}  (цвет={meta['colour']})")
