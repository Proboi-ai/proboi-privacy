#!/usr/bin/env python3
"""Непредвзятая проверка связки на ОТЛОЖЕННЫХ документах, которых конвейер не видел.

Зачем отдельный скрипт. Все цифры конвейера получены на 15 страницах, по которым его
и настраивали. В этом проекте показатели уже дважды рушились на невиденных данных
(гео-детекторы 97,5 → 66,7 %), так что «48 % полей при 95 %» — это пока «48 % на
пятнадцати страницах», а не свойство конвейера.

ГЛАВНАЯ ИДЕЯ — МЕРИТЬ ТОЧНОСТЬ БЕЗ ПОЛНОЙ РАЗМЕТКИ. Чтобы узнать полноту, эталон нужен
весь: надо знать, сколько полей на странице всего. Чтобы узнать ТОЧНОСТЬ принятого,
достаточно проверить только то, что конвейер принял, — это несколько десятков чтений
на десяток страниц, полчаса работы человека вместо дней разметки. Скрипт готовит ровно
такой список: чтение, вырезка, страница — глазами сверить и отметить.

Отбор страниц повторяет стенд 06.08 (доля чернил на 18 dpi, лучшие страницы документа),
с одной оговоркой: там финальные 30 страниц выбирал человек глазами по эскизам, здесь
берётся автоматический топ. Поэтому набор страниц НЕ идентичен по способу отбора, и
сравнивать с 15 страницами стенда нужно с этой поправкой.

  holdout_run.py <док,док,...> [--per-doc=2] [--out=holdout]
"""
import glob
import json
import os
import subprocess
import sys

from PIL import Image

SRC = "/opt/geo-holdout-20260806"
WORK = "holdoutwork"


def ink_rank(doc):
    """Доля чернил по страницам при 18 dpi — тот же признак, что на стенде 06.08."""
    prefix = f"{WORK}/r{doc}"
    for f in glob.glob(prefix + "*"):
        os.remove(f)
    subprocess.run(["pdftoppm", "-gray", "-r", "18", f"{SRC}/holdout-{doc}.pdf", prefix],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
    pages = []
    for f in sorted(glob.glob(prefix + "-*.pgm")):
        im = Image.open(f).convert("L")
        px = list(im.getdata())
        n = len(px)
        if n:
            srt = sorted(px)
            bg = srt[int(n * 0.85)]
            thr = max(40, int(bg * 0.72))
            pages.append((int(f.rsplit("-", 1)[1].split(".")[0]),
                          round(sum(1 for v in px if v < thr) / n, 4)))
        os.remove(f)
    return sorted(pages, key=lambda x: -x[1])


def main():
    docs = sys.argv[1].split(",")
    per_doc, out = 2, "holdout"
    for a in sys.argv[2:]:
        if a.startswith("--per-doc="):
            per_doc = int(a.split("=")[1])
        if a.startswith("--out="):
            out = a.split("=")[1]
    os.makedirs(WORK, exist_ok=True)
    os.makedirs("bench/img300", exist_ok=True)

    chosen = []
    for d in docs:
        rank = ink_rank(d)
        top = rank[:per_doc]
        print(f"holdout-{d}: страниц {len(rank)}, берём {[p for p, _ in top]} "
              f"(чернил {[i for _, i in top]})", flush=True)
        for pg, _ in top:
            name = f"h{d}_{pg}"
            subprocess.run(["pdftoppm", "-jpeg", "-jpegopt", "quality=93", "-r", "300",
                            "-f", str(pg), "-l", str(pg), "-singlefile",
                            f"{SRC}/holdout-{d}.pdf", f"bench/img300/{name}"],
                           check=True, timeout=900)
            chosen.append(name)
    with open(f"{out}_pages.txt", "w") as f:
        f.write(",".join(chosen))
    print(f"\nстраниц отобрано: {len(chosen)} → {out}_pages.txt")
    print(",".join(chosen))


if __name__ == "__main__":
    main()
