#!/usr/bin/env python3
"""Насколько верно `fieldmap.py` называет поля — замер по эталону.

Как меряем, не имея разметки «какая рамка какому полю принадлежит». Эталон знает
пары (поле, значение) на странице, но не знает координат. Значит опору берём от
чтения: если модель прочитала на вырезке ЗНАЧЕНИЕ ИЗ ЭТАЛОНА, мы знаем, какое поле
там на самом деле, и можем проверить присвоенное имя.

Оговорка, которую надо держать в голове: у страницы бывают два поля с одинаковым
значением («начата» = «закончена» = 07.04.2021, «мерзлота до» = «общая глубина» =
3,2). В таких случаях засчитываем попадание в ЛЮБОЕ из них — метрика тут мягче
правды, и число таких пар печатается отдельной строкой, чтобы поблажка была видна.

Второй показатель — охват: доля полей эталона, до которых конвейер вообще добрался
(значение прочитано верно И имя присвоено верно). Это и есть «сколько полей можно
отдать человеку осмысленными».

  score_fields.py <gt.jsonl> <чтения.values.jsonl> [ещё.values.jsonl] [--dir=img300]
"""
import json
import re
import sys
from collections import Counter, defaultdict

from fieldmap import attach


def key(v):
    """Числовое ядро значения: цифры и разделитель. «19,7» и «19.7» — одно."""
    s = str(v).strip().lower().replace(",", ".").replace(" ", "")
    return re.sub(r"[^0-9.]", "", s)


def main():
    gt_path = sys.argv[1]
    vpaths, d = [], "img300"
    for a in sys.argv[2:]:
        if a.startswith("--dir="):
            d = a.split("=")[1]
        else:
            vpaths.append(a)

    gt = {}
    for line in open(gt_path):
        if line.strip():
            o = json.loads(line)
            gt[o["page"]] = o

    # чтения: рамка → тексты всех читателей (имя поля от модели не зависит)
    reads = defaultdict(dict)
    for p in vpaths:
        for line in open(p):
            if line.strip():
                o = json.loads(line)
                reads[o["page"]][tuple(o["box"])] = o["text"].strip()

    tot = Counter()
    per_field = defaultdict(Counter)
    wrong = []
    ambiguous = 0
    for page, g in sorted(gt.items()):
        if page not in reads:
            continue
        # значение эталона → множество полей с таким значением
        by_val = defaultdict(set)
        for f in g.get("key", []):
            if key(f["v"]):
                by_val[key(f["v"])].add(f["f"])
        ambiguous += sum(1 for v, fs in by_val.items() if len(fs) > 1)

        boxes = [dict(box=list(b)) for b in reads[page]]
        named = {r["box"]: r["field"] for r in attach(f"{d}/{page}.jpg", boxes)}

        hit_fields = set()
        for box, text in reads[page].items():
            k = key(text)
            if not k or k not in by_val:
                continue                      # чтение не совпало с эталоном — не судим
            tot["сверено"] += 1
            got = named.get(box)
            true = by_val[k]
            if got in true:
                tot["верное имя"] += 1
                hit_fields |= {got}
                for f in true:
                    per_field[f]["верно"] += 1
            elif got is None:
                tot["без имени"] += 1
                for f in true:
                    per_field[f]["без имени"] += 1
            else:
                tot["чужое имя"] += 1
                wrong.append(f"{page}: {text!r} → {got} (на деле {'/'.join(sorted(true))})")
                for f in true:
                    per_field[f]["чужое"] += 1
        tot["полей эталона"] += len(g.get("key", []))
        tot["полей закрыто"] += len(hit_fields)

    n = tot["сверено"]
    print(f"страниц: {len({p for p in gt if p in reads})} · "
          f"полей в эталоне: {tot['полей эталона']}")
    print(f"чтений, совпавших со значением эталона: {n}")
    print(f"  верное имя поля : {tot['верное имя']:4d}  {tot['верное имя']/max(1,n):6.1%}")
    print(f"  имя не присвоено: {tot['без имени']:4d}  {tot['без имени']/max(1,n):6.1%}")
    print(f"  ЧУЖОЕ имя       : {tot['чужое имя']:4d}  {tot['чужое имя']/max(1,n):6.1%}")
    print(f"\nполей эталона закрыто (значение верно И имя верно): "
          f"{tot['полей закрыто']} из {tot['полей эталона']} = "
          f"{tot['полей закрыто']/max(1,tot['полей эталона']):.1%}")
    print(f"поблажка: пар «одно значение — разные поля» на страницах: {ambiguous}")

    if wrong:
        print(f"\nчужие имена ({len(wrong)}):")
        for w in wrong[:25]:
            print("   " + w)

    print("\nпо полям (верно / без имени / чужое):")
    for f, c in sorted(per_field.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"   {f:34s} {c['верно']:3d} / {c['без имени']:3d} / {c['чужое']:3d}")


if __name__ == "__main__":
    main()
