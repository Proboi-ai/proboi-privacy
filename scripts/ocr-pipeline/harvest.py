#!/usr/bin/env python3
"""Сбор обучающего корпуса БЕЗ ручной разметки — псевдо-метки по фильтру доверия.

Отчёт 06.08 оценивал вход в дообучение в 8–12 часов работы человека, знающего
домен (3000 строк править руками). Этого блокера можно избежать: у нас 402
страницы того же архива, на которых мы НЕ меряем, и уже измеренный фильтр,
после которого чтениям можно верить.

Правило отбора (осознанно жёсткое — в обучении цена грязной метки выше цены
пропуска):
  1. чернил в кропе не меньше порога        — на пустом кропе модель печатает
                                              заученное, такой пары в корпусе быть не должно
  2. уверенность не ниже калиброванной      — порог берём из calib.py, не с потолка
  3. чтение проходит грамматику поля        — verify.check_field, если поле опознано
  4. (если задано) вторая модель согласна   — согласие двух сильных дало 5,6 % ошибок

Страницы эталона сюда не попадают по построению: их нет в train300.

  harvest.py <model_id> <out.jsonl> [--conf=0.9] [--px=200] [--limit=N] [--second=model_id]
"""
import glob
import json
import os
import sys

import numpy as np
import torch
from PIL import Image
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

from values import extract
from score import nums

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
SRC = "train300"
CROPS = "traincrops"


@torch.no_grad()
def rec(model, proc, ims):
    px = proc(images=ims, return_tensors="pt").pixel_values.to(DEV)
    o = model.generate(px, max_new_tokens=32, num_beams=1,
                       output_scores=True, return_dict_in_generate=True)
    txt = proc.batch_decode(o.sequences, skip_special_tokens=True)
    tr = model.compute_transition_scores(o.sequences, o.scores, normalize_logits=True)
    t = tr.float().cpu().numpy()
    p = np.exp(t)
    ok = np.isfinite(t)
    cm, ci = [], []
    for i in range(p.shape[0]):
        v = p[i][ok[i]]
        v = v[:-1] if v.size > 1 else v
        cm.append(float(v.mean()) if v.size else 0.0)
        ci.append(float(v.min()) if v.size else 0.0)
    return txt, cm, ci


def main():
    mid, outp = sys.argv[1], sys.argv[2]
    conf_th, px_th, limit, second, shard = 0.9, 200, None, None, None
    for a in sys.argv[3:]:
        if a.startswith("--conf="): conf_th = float(a.split("=")[1])
        if a.startswith("--px="): px_th = int(a.split("=")[1])
        if a.startswith("--limit="): limit = int(a.split("=")[1])
        if a.startswith("--second="): second = a.split("=")[1]
        # --shard=i/n — своя доля страниц на каждую машину, чтобы две не делали одно и то же
        if a.startswith("--shard="): shard = tuple(int(x) for x in a.split("=")[1].split("/"))

    proc = TrOCRProcessor.from_pretrained(mid)
    model = VisionEncoderDecoderModel.from_pretrained(mid).to(DEV).eval()
    proc2 = model2 = None
    if second:
        proc2 = TrOCRProcessor.from_pretrained(second)
        model2 = VisionEncoderDecoderModel.from_pretrained(second).to(DEV).eval()

    os.makedirs(CROPS, exist_ok=True)
    pages = sorted(glob.glob(f"{SRC}/*.jpg"))
    if shard:
        i, n = shard
        pages = [p for k, p in enumerate(pages) if k % n == (i - 1)]
        print(f"доля {i}/{n}: страниц {len(pages)}")
    if limit:
        pages = pages[:limit]
    kept = seen = 0
    stat = dict(мало_чернил=0, низкая_уверенность=0, не_согласились=0, пусто=0)
    with open(outp, "w") as out:
        for k, path in enumerate(pages, 1):
            pg = os.path.basename(path).rsplit(".", 1)[0]
            try:
                vals, meta = extract(path)
            except Exception as e:
                print(f"  {pg}: пропущена ({e})", flush=True)
                continue
            keep_idx = [i for i, v in enumerate(vals) if v["px"] >= px_th]
            stat["мало_чернил"] += len(vals) - len(keep_idx)
            vals = [vals[i] for i in keep_idx]
            for i in range(0, len(vals), 8):
                ch = vals[i:i + 8]
                ims = [c["crop"].convert("RGB") for c in ch]
                tx, cm, ci = rec(model, proc, ims)
                tx2 = [None] * len(ch)
                if model2 is not None:
                    tx2, _, _ = rec(model2, proc2, ims)
                for c, t, a, t2 in zip(ch, tx, cm, tx2):
                    seen += 1
                    s = (t or "").strip()
                    if not s:
                        stat["пусто"] += 1
                        continue
                    if a < conf_th:
                        stat["низкая_уверенность"] += 1
                        continue
                    if model2 is not None and (t2 or "").strip() != s:
                        stat["не_согласились"] += 1
                        continue
                    fn = f"{CROPS}/{pg}_{c['box'][0]}_{c['box'][1]}.png"
                    c["crop"].save(fn)
                    out.write(json.dumps(dict(img=fn, text=s, conf=round(a, 4),
                                              px=c["px"], page=pg,
                                              digits=len("".join(nums(s)))),
                                         ensure_ascii=False) + "\n")
                    kept += 1
            if k % 20 == 0:
                print(f"  {k}/{len(pages)} страниц, пар {kept}", flush=True)
    print(f"собрано пар: {kept} из {seen} кропов")
    print("отсев:", stat)


if __name__ == "__main__":
    main()
