#!/usr/bin/env python3
"""Приписать имя поля обучающим меткам и починить потерянную запятую С ГЕЙТОМ.

Порядок из хендоффа (пункт 4 «что делать дальше», задача возвращения к
дообучению): имена полей обучающим вырезкам → починка меток `sepfix` С
ГЕЙТОМ → только потом эпоха. Без первых двух шагов дообучение делает
десятичные ХУЖЕ — измерено (эталон 34,1 % чисел с разделителем → метки
согласия 10,1 % → дообученная модель ещё ниже с каждой эпохой,
самодистилляция закрепляет ошибку).

Метки берутся из СОГЛАСИЯ двух моделей на изолированных вырезках
(`harvest.py`) — имени поля у них нет вообще, потому что на момент сбора
контекст страницы для этого не использовался. Присваиваем его здесь: box
восстанавливаем из имени файла кропа (`traincrops/{page}_{x0}_{y0}.png`,
x1,y1 — по размеру самого PNG) и размера страницы `page`, отдаём
`fieldmap.attach()`. Дальше та же функция и тот же гейт `decimal_fields()`,
что уже измерены в `sepfix.py` (5 из 5 верных, 0 испорченных) — не новый код,
применение проверенного к новым данным.

  fix_labels.py <train_pairs.jsonl> <train300 dir> <out.jsonl>
"""
import json
import os
import re
import sys
from collections import defaultdict

from PIL import Image

from fieldmap import attach
from sepfix import decimal_fields, fix as sepfix_fix

BOX_RE = re.compile(r"_(\d+)_(\d+)\.png$")


def main():
    inp, src_dir, outp = sys.argv[1], sys.argv[2], sys.argv[3]
    dec = decimal_fields()

    rows = [json.loads(l) for l in open(inp) if l.strip()]
    by_page = defaultdict(list)
    for i, r in enumerate(rows):
        by_page[r["page"]].append(i)

    named = fixed = skipped_pages = 0
    for page, idxs in sorted(by_page.items()):
        path = f"{src_dir}/{page}.jpg"
        if not os.path.exists(path):
            skipped_pages += 1
            continue
        entries = []      # (row_idx, box, PIL crop)
        for i in idxs:
            r = rows[i]
            m = BOX_RE.search(r["img"])
            if not m:
                continue
            x0, y0 = int(m.group(1)), int(m.group(2))
            im = Image.open(r["img"])
            w, h = im.size
            entries.append((i, (x0, y0, x0 + w, y0 + h), im))
        if not entries:
            continue
        try:
            info = attach(path, [dict(box=b, px=0) for _, b, _ in entries])
        except Exception as e:
            print(f"{page}: ошибка fieldmap: {e}", flush=True)
            continue
        by_box = {r["box"]: r["field"] for r in info}
        for i, box, im in entries:
            field = by_box.get(box)
            rows[i]["field"] = field
            rows[i]["text_orig"] = rows[i]["text"]
            if field:
                named += 1
            new_text, why = sepfix_fix(rows[i]["text"], im, field, dec)
            if why:
                rows[i]["text"] = new_text
                rows[i]["fix"] = why
                fixed += 1

    with open(outp, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"строк: {len(rows)}, страниц без исходника: {skipped_pages}, "
          f"с именем поля: {named} ({named/max(1,len(rows)):.0%}), "
          f"исправлено запятых: {fixed}")


if __name__ == "__main__":
    main()
