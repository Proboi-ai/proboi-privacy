#!/usr/bin/env python3
"""Метрики замера распознавания рукописных геологических журналов.

Три метрики, а не одна:
  1. Полнота по числам  — доля эталонных числовых полей, найденных в выводе.
  2. Ложные числа       — сколько «длинных» (>=3 цифр) чисел модель выдала сверх эталона.
                          Это прямой замер выдумывания: пропуск и выдумка — разные беды.
  3. CER / WER          — по рукописным строкам, через infix-выравнивание: строка ищется
                          лучшим подокном в полном выводе, поэтому лишний печатный текст
                          вокруг не штрафуется.
Стабильность считается отдельно (stability.py) и эталона не требует.
"""
import json
import re
import sys
import unicodedata

NUM = re.compile(r"\d+(?:[.,]\d+)*")


def norm_num(t):
    t = t.replace(",", ".")
    # 1 234,5 -> 1234.5 уже разбито токенизатором; убираем ведущие нули только у целых
    if "." not in t:
        t = t.lstrip("0") or "0"
    return t


def nums(text):
    return [norm_num(t) for t in NUM.findall(text or "")]


def norm_text(s):
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = s.replace("ё", "е").replace("«", '"').replace("»", '"')
    s = re.sub(r"[^\wа-я0-9.,°'\-/% ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def lev(a, b):
    if not a:
        return len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def infix_dist(ref, hyp):
    """Расстояние ref до ЛУЧШЕГО подокна hyp: префикс и суффикс hyp бесплатны."""
    if not ref:
        return 0
    if not hyp:
        return len(ref)
    prev = [0] * (len(hyp) + 1)          # старт бесплатен в любой позиции hyp
    for i, cr in enumerate(ref, 1):
        cur = [i]
        for j, ch in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (cr != ch)))
        prev = cur
    return min(prev)                      # конец бесплатен в любой позиции hyp


def score_page(gt, out, include_uncertain=False, boiler=frozenset(), min_digits=1):
    """min_digits=3 — строгий режим: короткие 1-2-значные поля выкидываем, их легко
    поймать случайно в любом месте вывода, и полнота от этого раздувается."""
    pool = nums(out)
    from collections import Counter
    have = Counter(pool)
    found = miss = skipped = 0
    misses = []
    for f in gt["key"]:
        if f.get("conf") in ("low",) and not include_uncertain:
            skipped += 1
            continue
        if sum(len(t.replace(".", "")) for t in nums(f["v"])) < min_digits:
            skipped += 1
            continue
        variants = [f["v"]] + f.get("alt", [])
        ok = False
        for v in variants:
            need = Counter(nums(v))
            if need and all(have[k] >= c for k, c in need.items()):
                ok = True
                break
        if ok:
            found += 1
        else:
            miss += 1
            misses.append(f"{f['f']}={f['v']}")
    # ложные длинные числа
    gt_all = Counter()
    for f in gt["key"]:
        for v in [f["v"]] + f.get("alt", []):
            for t in nums(v):
                gt_all[t] = max(gt_all[t], 1)
    long_out = [t for t in pool if len(t.replace(".", "")) >= 3]
    ghosts = [t for t in long_out if gt_all[t] == 0]
    # разделяем беды: искажение реального числа против выдумки на пустом месте
    refs = [k for k in gt_all if len(k.replace(".", "")) >= 2]
    refd = [r.replace(".", "") for r in refs]
    frag, corrupt, invented, printed = [], [], [], []
    for g in ghosts:
        gd = g.replace(".", "")
        if g in boiler:
            printed.append(g)       # повторяется на разных страницах = печатный бланк, не рукопись
        elif any(gd in r or r in gd for r in refd):
            frag.append(g)          # кусок настоящего числа, разорванный токенизатором
        elif any(lev(gd, r) <= max(1, len(gd) // 3) for r in refd):
            corrupt.append(g)       # реальное число прочитано с ошибкой в цифрах
        else:
            invented.append(g)      # на бумаге такого числа нет вовсе
    # CER/WER по рукописным текстовым полям
    hyp = norm_text(out)
    cer_n = cer_d = wer_n = wer_d = 0
    for f in gt.get("text", []):
        if f.get("printed") or f.get("conf") == "low":
            continue
        r = norm_text(f["v"])
        if not r:
            continue
        cer_n += infix_dist(r, hyp)
        cer_d += len(r)
        rw, hw = r.split(), hyp.split()
        wer_n += infix_dist(rw, hw)
        wer_d += len(rw)
    return dict(found=found, miss=miss, skipped=skipped, misses=misses,
                ghosts=len(ghosts), printed=len(printed), frag=len(frag), corrupt=len(corrupt),
                invented=len(invented), inv_vals=invented[:10], long_out=len(long_out),
                cer_n=cer_n, cer_d=cer_d, wer_n=wer_n, wer_d=wer_d)


def main():
    gt = {json.loads(l)["page"]: json.loads(l) for l in open(sys.argv[1]) if l.strip()}
    outs = {json.loads(l)["page"]: json.loads(l)["text"] for l in open(sys.argv[2]) if l.strip()}
    tot = dict(found=0, miss=0, skipped=0, ghosts=0, printed=0, frag=0, corrupt=0, invented=0,
               long_out=0,
               cer_n=0, cer_d=0, wer_n=0, wer_d=0)
    # печатный бланк: длинное число, встретившееся у ЭТОЙ модели на >=3 разных страницах
    from collections import Counter as _C
    seen = _C()
    for p, t in outs.items():
        for v in set(x for x in nums(t) if len(x.replace(".", "")) >= 3):
            seen[v] += 1
    boiler = frozenset(v for v, c in seen.items() if c >= 3)
    per = []
    for p, g in gt.items():
        if p not in outs:
            continue
        s = score_page(g, outs[p], boiler=boiler,
                       min_digits=3 if "--strict" in sys.argv else 1)
        per.append((p, s))
        for k in tot:
            tot[k] += s[k]
    n = tot["found"] + tot["miss"]
    rec = tot["found"] / n if n else 0
    cer = tot["cer_n"] / tot["cer_d"] if tot["cer_d"] else float("nan")
    wer = tot["wer_n"] / tot["wer_d"] if tot["wer_d"] else float("nan")
    print(f"страниц: {len(per)}")
    print(f"полнота по числам: {rec:.1%}  ({tot['found']}/{n}, неуверенных пропущено {tot['skipped']})")
    print(f"числа сверх эталона: {tot['ghosts']} из {tot['long_out']} выданных длинных"
          f"\n  ├ печатный бланк: {tot['printed']}"
          f"\n  ├ обрывки настоящих: {tot['frag']}"
          f"\n  ├ искажения реальных: {tot['corrupt']}"
          f"\n  └ ВЫДУМАНО из ничего: {tot['invented']}")
    print(f"CER (рукописные строки): {cer:.1%}   WER: {wer:.1%}")
    if "-v" in sys.argv:
        for p, s in per:
            print(f"  {p}: +{s['found']} -{s['miss']} призраков {s['ghosts']}"
                  f" (искажений {s['corrupt']}, выдумок {s['invented']})"
                  f" | не найдено: {', '.join(s['misses'][:5])}")
    print(json.dumps(dict(recall=rec, found=tot["found"], total=n, ghosts=tot["ghosts"],
                          printed=tot["printed"], frag=tot["frag"], corrupt=tot["corrupt"],
                          invented=tot["invented"],
                          long_out=tot["long_out"], cer=cer, wer=wer), ensure_ascii=False))


if __name__ == "__main__":
    main()
