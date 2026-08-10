#!/usr/bin/env python3
"""Отложенная выборка ТОЛЬКО из карточек — по разметке `pagetype.py`.

Чем отличается от `holdout_run.py`. Тот отбирал страницы по количеству чернил, и
на нетронутых документах это дало вместо буровых журналов печатный разрез и две
машинописные копии, а потом — таблицы описания керна вместо карточек. Здесь отбор
идёт по ТИПУ страницы, а внутри типа — жребием с фиксированным зерном, а не «по
максимуму чего-нибудь». Максимум чего угодно — это скрытый отбор лучших страниц,
и он уже дважды делал цифры красивее, чем они есть.

Раскладка по документам обязательна: карточек в документе от 3 до 10, и если брать
жребий по всему корпусу, половина выборки уедет в два самых толстых журнала.

  sample_cards.py <pagetype.tsv> [--per-doc=2] [--kind=карточка] [--seed=20260810]
                  [--out=cards] [--dpi=300] [--src=/opt/geo-holdout-20260806]
"""
import csv
import os
import random
import subprocess
import sys
from collections import defaultdict


def main():
    tsv = sys.argv[1]
    per_doc, kind, seed, out, dpi = 2, "карточка", 20260810, "cards", 300
    src = "/opt/geo-holdout-20260806"
    for a in sys.argv[2:]:
        if a.startswith("--per-doc="):
            per_doc = int(a.split("=")[1])
        elif a.startswith("--kind="):
            kind = a.split("=")[1]
        elif a.startswith("--seed="):
            seed = int(a.split("=")[1])
        elif a.startswith("--out="):
            out = a.split("=")[1]
        elif a.startswith("--dpi="):
            dpi = int(a.split("=")[1])
        elif a.startswith("--src="):
            src = a.split("=")[1]

    by_doc = defaultdict(list)
    for r in csv.DictReader(open(tsv), delimiter="\t"):
        # только рукописные: машинописные копии того же бланка идут в обычный OCR
        if r["kind"] == kind and r["colour"] == "1":
            by_doc[r["page"].split("_")[0]].append(r["page"])

    rnd = random.Random(seed)
    chosen = []
    for doc in sorted(by_doc):
        pages = sorted(by_doc[doc], key=lambda p: int(p.split("_")[1]))
        take = rnd.sample(pages, min(per_doc, len(pages)))
        chosen += sorted(take, key=lambda p: int(p.split("_")[1]))
        print(f"{doc}: {kind} {len(pages)} → берём {sorted(take)}")

    os.makedirs("img300", exist_ok=True)
    for name in chosen:
        doc, pg = name[1:].split("_")
        dst = f"img300/{name}"
        if os.path.exists(dst + ".jpg"):
            print(f"  {name}: уже отрисована")
            continue
        subprocess.run(["pdftoppm", "-jpeg", "-jpegopt", "quality=93", "-r", str(dpi),
                        "-f", pg, "-l", pg, "-singlefile",
                        f"{src}/holdout-{doc}.pdf", dst], check=True, timeout=900)
        print(f"  {name}: отрисована {dpi} dpi")

    with open(f"{out}_pages.txt", "w") as f:
        f.write(",".join(chosen))
    print(f"\nстраниц отобрано: {len(chosen)} из {len(by_doc)} документов → {out}_pages.txt")
    print(",".join(chosen))


if __name__ == "__main__":
    main()
