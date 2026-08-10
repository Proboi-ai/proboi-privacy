#!/usr/bin/env python3
"""Сколько ядер и как их делить: потоки внутри процесса против числа процессов.

Вопрос не праздный. Распознавание вырезок — задача, которая параллелится по СТРАНИЦАМ
идеально, а внутри одного вызова модели плохо: матричные умножения на 16 потоках дают
далеко не 16-кратное ускорение. Поэтому «сколько ядер надо» и «сколько потоков ставить»
— два разных вопроса, и ответ на второй почти всегда «меньше, чем ядер».

Меряем две оси:
  1. потоки в ОДНОМ процессе (1..N) — где кривая перестаёт расти
  2. P процессов × T потоков при P*T = N ядер — совокупная пропускная способность

Вторая ось и есть ответ для оцифровки архива: там важны страницы в час на машину,
а не задержка одной страницы.

ПАМЯТЬ ограничивает число процессов не меньше, чем ядра: каждый процесс держит свою
копию весов (TrOCR-large в fp32 — 2,4 ГБ, base — 1,3 ГБ). Это печатается в отчёте.

  scale.py one <потоков> <кропов>     — один рабочий процесс, печатает секунды
  scale.py all [--model=ID] [--cores=N] [--crops=N]
"""
import os
import subprocess
import sys
import time

MID = os.environ.get("SCALE_MODEL", "Kansallisarkisto/cyrillic-large-handwritten")


def worker(nthreads, ncrops, reps=2):
    import torch
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel
    from values import extract
    torch.set_num_threads(nthreads)
    proc = TrOCRProcessor.from_pretrained(MID)
    model = VisionEncoderDecoderModel.from_pretrained(MID).eval()
    vals, _ = extract("bench/img300/p020_5.jpg")
    ims = [c["crop"].convert("RGB") for c in vals[:ncrops]]
    px = proc(images=ims, return_tensors="pt").pixel_values
    with torch.no_grad():
        model.generate(px, max_new_tokens=32, num_beams=1)      # прогрев, не мерим
        t0 = time.time()
        for _ in range(reps):
            model.generate(px, max_new_tokens=32, num_beams=1)
        return (time.time() - t0) / reps


def rss_mb():
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGESIZE") // 2**20
    except OSError:
        return 0


def run_procs(nproc, nthreads, ncrops):
    """P процессов разом; берём МАКСИМУМ времени — пока не закончил последний,
    машина занята, и именно это определяет пропускную способность."""
    env = dict(os.environ, OMP_NUM_THREADS=str(nthreads),
               MKL_NUM_THREADS=str(nthreads), SCALE_MODEL=MID)
    t0 = time.time()
    ps = [subprocess.Popen([sys.executable, __file__, "one", str(nthreads), str(ncrops)],
                           stdout=subprocess.PIPE, env=env) for _ in range(nproc)]
    outs = [p.communicate()[0].decode().strip() for p in ps]
    wall = time.time() - t0
    per = [float(o.split()[0]) for o in outs if o]
    return (max(per) if per else float("nan")), wall


def main():
    cores = os.cpu_count()
    crops = 8
    args = sys.argv[2:]
    for a in args:
        if a.startswith("--model="):
            globals()["MID"] = a.split("=", 1)[1]
        if a.startswith("--cores="):
            cores = int(a.split("=")[1])
        if a.startswith("--crops="):
            crops = int(a.split("=")[1])
    print(f"модель {MID} · ядер на машине {os.cpu_count()} · считаем на {cores} "
          f"· батч {crops} кропов\n")

    print("ОСЬ 1 — потоки в ОДНОМ процессе (задержка одной страницы)")
    print(f"{'потоков':>8}{'с/батч':>9}{'кроп/с':>9}{'ускорение':>11}{'КПД ядра':>10}")
    base = None
    t = 1
    while t <= cores:
        dt = worker(t, crops)
        if base is None:
            base = dt
        print(f"{t:>8}{dt:>9.2f}{crops/dt:>9.2f}{base/dt:>10.2f}x{base/dt/t:>9.0%}", flush=True)
        t *= 2

    print(f"\nОСЬ 2 — как поделить {cores} ядер (совокупная пропускная способность)")
    print(f"{'процессов':>10}{'потоков':>9}{'с/батч':>9}{'кроп/с всего':>14}"
          f"{'против 1×N':>12}")
    ref = None
    p = 1
    while p <= cores:
        thr = max(1, cores // p)
        slowest, wall = run_procs(p, thr, crops)
        total = p * crops / slowest
        if ref is None:
            ref = total
        print(f"{p:>10}{thr:>9}{slowest:>9.2f}{total:>14.2f}{total/ref:>11.2f}x",
              flush=True)
        p *= 2


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "one":
        print(f"{worker(int(sys.argv[2]), int(sys.argv[3])):.4f}")
    else:
        main()
