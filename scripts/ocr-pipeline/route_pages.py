#!/usr/bin/env python3
"""Маршрутизатор страниц: где рукопись синей ручкой, а где машинопись или чертёж.

Понадобился после того, как автоотбор «по количеству чернил» на отложенном корпусе
дал вместо буровых журналов печатный геологический разрез и две машинописные копии
того же бланка. Оказалось, архив недропользователя НЕОДНОРОДЕН: один и тот же бланк
журнала встречается и заполненным от руки, и набранным на машинке.

Для конвейера это не мелочь. Цветовое разделение — его главный рычаг (+18 пунктов) —
на машинописи не работает вовсе: синих чернил там нет, и `inklayer.split` честно
откатывается в серое. Гнать такие страницы через распознаватель рукописного текста
бессмысленно, их место в обычном OCR.

Признак уже есть внутри `inklayer.split`: доля синего в чернилах (`blue_share`) и флаг
`colour`. Здесь он просто вынесен наружу и посчитан по страницам — на низком
разрешении, чтобы это стоило копейки.

  route_pages.py <pdf> [<pdf> ...] [--dpi=72] [--top=2] [--min-share=0.02]
"""
import glob
import os
import subprocess
import sys
import tempfile

from PIL import Image

from inklayer import split


def pages_of(pdf, dpi, tmp):
    prefix = os.path.join(tmp, "p")
    subprocess.run(["pdftoppm", "-jpeg", "-r", str(dpi), pdf, prefix],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3600)
    return sorted(glob.glob(prefix + "-*.jpg"))


def main():
    dpi, top, min_share = 72, 2, 0.02
    pdfs = []
    for a in sys.argv[1:]:
        if a.startswith("--dpi="):
            dpi = int(a.split("=")[1])
        elif a.startswith("--top="):
            top = int(a.split("=")[1])
        elif a.startswith("--min-share="):
            min_share = float(a.split("=")[1])
        else:
            pdfs.append(a)

    all_hand, all_pages, picked = 0, 0, []
    print(f"{'документ':22s}{'стр':>5}{'рукописных':>12}{'доля':>7}   лучшие страницы")
    for pdf in pdfs:
        doc = os.path.basename(pdf).rsplit(".", 1)[0].replace("holdout-", "")
        with tempfile.TemporaryDirectory() as tmp:
            files = pages_of(pdf, dpi, tmp)
            rows = []
            for f in files:
                pg = int(f.rsplit("-", 1)[1].split(".")[0])
                try:
                    _, _, meta = split(f, min_share=min_share)
                except Exception:
                    continue
                rows.append((pg, meta["colour"], meta["blue_share"]))
        hand = [r for r in rows if r[1]]
        all_hand += len(hand)
        all_pages += len(rows)
        best = sorted(hand, key=lambda r: -r[2])[:top]
        picked += [f"h{doc}_{pg}" for pg, _, _ in best]
        share = len(hand) / max(1, len(rows))
        print(f"{doc:22s}{len(rows):>5}{len(hand):>12}{share:>6.0%}   "
              f"{[(pg, f'{s:.0%}') for pg, _, s in best]}", flush=True)

    print(f"\nвсего страниц {all_pages}, рукописных {all_hand} "
          f"({all_hand/max(1,all_pages):.0%})")
    print("отобрано:", ",".join(picked))
    with open("route_pages.txt", "w") as f:
        f.write(",".join(picked))


if __name__ == "__main__":
    main()
