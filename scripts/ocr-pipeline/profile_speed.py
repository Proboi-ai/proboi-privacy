#!/usr/bin/env python3
"""Куда уходит время распознавания вырезки и чем его можно срезать.

Три вопроса, на которые нельзя ответить рассуждением:

1. ЭНКОДЕР ИЛИ ДЕКОДЕР. Чтения у нас короткие (медиана 2–3 знака), поэтому декодер
   должен быть дёшев, а всё время должен съедать ViT над картинкой. Если так —
   «дообучить, чтобы модель отвечала короче» скорости уже не даст, и ускорять надо
   энкодер: квантованием, меньшей моделью или меньшим числом вырезок.

2. УСКОРИЛО ЛИ ДООБУЧЕНИЕ. Базовые модели мерились на одной машине, дообученные на
   другой, и вывод «дообучение ускорило на 19–31 %» может оказаться разницей машин,
   а не моделей. Здесь все четыре гоняются подряд на ОДНОМ железе.

3. ДАЁТ ЛИ ЧТО-ТО КВАНТОВАНИЕ. int8 по линейным слоям обычно ускоряет трансформер на
   процессоре в 2–3 раза и не требует обучения вовсе. Печатаем и скорость, и сами
   чтения — если качество просядет, это будет видно сразу.

  profile_speed.py [--crops=8] [--threads=8]
"""
import sys
import time

import torch
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

from values import extract

MODELS = [
    ("основная база   Kansallisarkisto", "Kansallisarkisto/cyrillic-large-handwritten"),
    ("основная дооб.  ft/ep1", "ft/ep1"),
    ("второй  база    cyrillic-trocr", "cyrillic-trocr/trocr-handwritten-cyrillic"),
    ("второй  дооб.   ftcyr/ep2", "ftcyr/ep2"),
]


def bench(mid, ims, reps, quant=False):
    proc = TrOCRProcessor.from_pretrained(mid)
    model = VisionEncoderDecoderModel.from_pretrained(mid).eval()
    if quant:
        model = torch.quantization.quantize_dynamic(
            model, {torch.nn.Linear}, dtype=torch.qint8)
    px = proc(images=ims, return_tensors="pt").pixel_values
    with torch.no_grad():
        model.generate(px, max_new_tokens=32, num_beams=1)          # прогрев

        t0 = time.time()
        for _ in range(reps):
            enc = model.encoder(pixel_values=px)
        t_enc = (time.time() - t0) / reps

        t0 = time.time()
        for _ in range(reps):
            out = model.generate(px, max_new_tokens=32, num_beams=1)
        t_all = (time.time() - t0) / reps

    txt = proc.batch_decode(out, skip_special_tokens=True)
    return t_enc, t_all, txt


def main():
    crops, threads, reps = 8, 8, 2
    for a in sys.argv[1:]:
        if a.startswith("--crops="):
            crops = int(a.split("=")[1])
        if a.startswith("--threads="):
            threads = int(a.split("=")[1])
        if a.startswith("--reps="):
            reps = int(a.split("=")[1])
    torch.set_num_threads(threads)
    vals, _ = extract("bench/img300/p020_5.jpg")
    ims = [c["crop"].convert("RGB") for c in vals[:crops]]
    print(f"батч {crops} вырезок · потоков {threads} · повторов {reps} · "
          f"ОДНА машина, модели подряд\n")
    print(f"{'модель':34s}{'энкодер':>9}{'всего':>8}{'декодер':>9}"
          f"{'доля энкодера':>15}{'кроп/с':>8}")
    ref = {}
    for name, mid in MODELS:
        try:
            e, a, _ = bench(mid, ims, reps)
        except Exception as exc:
            print(f"{name:34s} не загрузилась: {exc}")
            continue
        ref[mid] = a
        print(f"{name:34s}{e:>8.2f}с{a:>7.2f}с{a-e:>8.2f}с{e/a:>14.0%}{crops/a:>8.2f}",
              flush=True)

    print(f"\nint8-квантование линейных слоёв (обучение не нужно):")
    for name, mid in (MODELS[1], MODELS[3]):
        try:
            e, a, txt = bench(mid, ims, reps, quant=True)
        except Exception as exc:
            print(f"{name:34s} квантование не прошло: {exc}")
            continue
        was = ref.get(mid)
        sp = f"{was/a:.2f}x" if was else "—"
        print(f"{name:34s}{e:>8.2f}с{a:>7.2f}с{a-e:>8.2f}с{'':>14}{crops/a:>8.2f}"
              f"   ускорение {sp}")
        print(f"    чтения после квантования: {txt}")


if __name__ == "__main__":
    main()
