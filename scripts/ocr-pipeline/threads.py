#!/usr/bin/env python3
"""Сколько потоков и сколько параллельных процессов имеет смысл на одной машине."""
import glob, os, subprocess, sys, time
import torch
from PIL import Image
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
MID="Kansallisarkisto/cyrillic-large-handwritten"

def crops(n=8):
    from values import extract
    v,_=extract("bench/img300/p020_5.jpg")
    return [c["crop"].convert("RGB") for c in v[:n]]

def worker(nthreads, n=8, reps=2):
    torch.set_num_threads(nthreads)
    proc=TrOCRProcessor.from_pretrained(MID)
    model=VisionEncoderDecoderModel.from_pretrained(MID).eval()
    ims=crops(n)
    px=proc(images=ims, return_tensors="pt").pixel_values
    with torch.no_grad():
        model.generate(px, max_new_tokens=32, num_beams=1)   # прогрев
        t0=time.time()
        for _ in range(reps):
            model.generate(px, max_new_tokens=32, num_beams=1)
        dt=(time.time()-t0)/reps
    return dt, n

if __name__=="__main__":
    if sys.argv[1]=="one":                      # режим одиночного рабочего процесса
        dt,n=worker(int(sys.argv[2]))
        print(f"{dt:.3f} {n}")
    else:
        print("ПОТОКИ в одном процессе (батч 8 кропов)")
        print(f"{'потоков':>8} {'с/батч':>8} {'кроп/с':>8} {'ускорение':>10}")
        base=None
        for t in (1,2,4,8,16):
            dt,n=worker(t)
            if base is None: base=dt
            print(f"{t:>8} {dt:>8.2f} {n/dt:>8.2f} {base/dt:>9.2f}x", flush=True)
