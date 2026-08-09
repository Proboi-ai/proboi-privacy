#!/usr/bin/env python3
"""Дообучение TrOCR на псевдо-размеченном корпусе, собранном по согласию двух моделей.

Метки получены фильтром, у которого измеренная точность 95,5 % (44 совпавших
чтения на эталоне, 0 выдумок). Это не идеальные метки, и это осознанный размен:
2200 пар настоящих чернил из этого же архива против 8–12 часов ручной работы.

Две вещи, которые здесь сделаны нарочно:

1. РАЗДЕЛЕНИЕ ПО ДОКУМЕНТАМ, а не по кропам. Соседние страницы одного журнала
   заполнены одной рукой, и случайное разбиение утечёт почерк из обучения в
   проверку — качество будет выглядеть выше, чем оно есть.
2. ПРОВЕРКА НА ЭТАЛОНЕ, а не на отложенной части псевдо-меток. Псевдо-метки
   содержат те же ошибки, что и модель, которая их породила: обучаясь и проверяясь
   на них, можно радостно измерить, как модель воспроизводит собственные ошибки.
   Настоящая цифра — строгая полнота на 15 размеченных руками страницах.

  finetune.py <pairs.jsonl> <outdir> [--epochs=3] [--lr=3e-5] [--batch=8] [--base=...]
"""
import json
import os
import random
import sys

import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

BASE = "Kansallisarkisto/cyrillic-large-handwritten"
DEV = ("mps" if torch.backends.mps.is_available()
       else ("cuda" if torch.cuda.is_available() else "cpu"))


class Pairs(Dataset):
    def __init__(self, rows, proc, max_len=32):
        self.rows, self.proc, self.max_len = rows, proc, max_len

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        im = Image.open(r["img"]).convert("RGB")
        px = self.proc(images=im, return_tensors="pt").pixel_values[0]
        ids = self.proc.tokenizer(r["text"], padding="max_length", truncation=True,
                                  max_length=self.max_len).input_ids
        pad = self.proc.tokenizer.pad_token_id
        labels = [(t if t != pad else -100) for t in ids]
        return dict(pixel_values=px, labels=torch.tensor(labels))


def doc_of(page):
    """p020_5 → 020: разделяем по ДОКУМЕНТУ, иначе один почерк утечёт в проверку."""
    return page.lstrip("p").split("_")[0]


def main():
    pairs_path, outdir = sys.argv[1], sys.argv[2]
    epochs, lr, batch, base, freeze = 3, 3e-5, 8, BASE, False
    for a in sys.argv[3:]:
        if a.startswith("--epochs="): epochs = int(a.split("=")[1])
        if a.startswith("--lr="): lr = float(a.split("=")[1])
        if a.startswith("--batch="): batch = int(a.split("=")[1])
        if a.startswith("--base="): base = a.split("=")[1]
        # --freeze-encoder: учим только декодер. Быстрее (обратный проход не идёт
        # через ViT-large) и точнее соответствует ожидаемой пользе: главный эффект
        # здесь — перестать выдавать заученный внедоменный текст, а это поведение
        # декодера, не зрения.
        if a == "--freeze-encoder": freeze = True

    rows = [json.loads(l) for l in open(pairs_path) if l.strip()]
    rows = [r for r in rows if os.path.exists(r["img"]) and r["text"].strip()]
    docs = sorted({doc_of(r["page"]) for r in rows})
    rnd = random.Random(20260808)
    rnd.shuffle(docs)
    if len(docs) >= 3:
        hold = set(docs[:max(1, len(docs) // 6)])
        tr = [r for r in rows if doc_of(r["page"]) not in hold]
        va = [r for r in rows if doc_of(r["page"]) in hold]
    else:
        # документов слишком мало для разделения по ним — иначе обучающая часть пустеет
        idx = list(range(len(rows)))
        rnd.shuffle(idx)
        cut = max(1, len(rows) // 7)
        va = [rows[i] for i in idx[:cut]]
        tr = [rows[i] for i in idx[cut:]]
        hold = {"<случайное разбиение: документов мало>"}
        print("ВНИМАНИЕ: документов <3, разделение случайное — один почерк попадёт "
              "и в обучение, и в проверку, цифре проверки не верить")
    if not tr:
        sys.exit("обучать не на чем: обучающая часть пуста")
    print(f"пар всего {len(rows)} · документов {len(docs)} · обучение {len(tr)} · "
          f"проверка {len(va)} (документы {sorted(hold)})")
    print("ВНИМАНИЕ: настоящая оценка — score.py на 15 размеченных руками страницах, "
          "а не эта проверка: она из тех же псевдо-меток и повторяет их ошибки.")

    proc = TrOCRProcessor.from_pretrained(base)
    model = VisionEncoderDecoderModel.from_pretrained(base).to(DEV)
    if freeze:
        for p in model.encoder.parameters():
            p.requires_grad = False
        n = sum(p.numel() for p in model.parameters() if p.requires_grad)
        print(f"энкодер заморожен, обучаемых параметров {n/1e6:.0f} млн")
    model.config.decoder_start_token_id = proc.tokenizer.cls_token_id or \
        model.config.decoder.decoder_start_token_id
    model.config.pad_token_id = proc.tokenizer.pad_token_id

    dl = DataLoader(Pairs(tr, proc), batch_size=batch, shuffle=True)
    dlv = DataLoader(Pairs(va, proc), batch_size=batch) if va else None
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                            lr=lr, weight_decay=0.01)
    steps = epochs * max(1, len(dl))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps,
                                                pct_start=0.1)
    step = 0
    for ep in range(epochs):
        model.train()
        run = 0.0
        for b in dl:
            out = model(pixel_values=b["pixel_values"].to(DEV),
                        labels=b["labels"].to(DEV))
            out.loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad()
            run += out.loss.item(); step += 1
            if step % 20 == 0:
                print(f"  эпоха {ep+1} шаг {step}/{steps} потеря {run/20:.4f}", flush=True)
                run = 0.0
        if dlv:
            model.eval()
            tot = n = 0
            with torch.no_grad():
                for b in dlv:
                    o = model(pixel_values=b["pixel_values"].to(DEV),
                              labels=b["labels"].to(DEV))
                    tot += o.loss.item(); n += 1
            print(f"эпоха {ep+1}: потеря на отложенных документах {tot/max(1,n):.4f}",
                  flush=True)
        d = f"{outdir}/ep{ep+1}"
        os.makedirs(d, exist_ok=True)
        model.save_pretrained(d); proc.save_pretrained(d)
        print(f"сохранено: {d}", flush=True)


if __name__ == "__main__":
    main()
