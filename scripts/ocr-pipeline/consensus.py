#!/usr/bin/env python3
"""Проверка идеи верификатора на УЖЕ собранных выводах: даёт ли согласие моделей точность.

Вопрос: если число выдали >=K независимых распознавателей, насколько оно верное?
Считаем на длинных числах (>=3 цифр) — это координаты, даты, отметки.
Никаких новых прогонов, только то, что уже лежит в out/.
"""
import json
import sys
from collections import Counter, defaultdict

from score import nums, lev

GT = "gt/gt.jsonl"
MODELS = {
    "kansall": "out/kansall_word_all.jsonl",
    "raxtemur": "out/raxtemur_word_all.jsonl",
    "easyocr": "out/easyocr_page.jsonl",
    "rukopys": "out/rukopys_final.jsonl",
    "kazars": "out/kazars_word.jsonl",
}


def load(path):
    d = {}
    for line in open(path):
        if line.strip():
            o = json.loads(line)
            d[o["page"]] = o["text"]
    return d


def longnums(text):
    return [t for t in nums(text) if len(t.replace(".", "")) >= 3]


def gt_longnums(g):
    """Все длинные числа эталона страницы (key + seq), с вариантами."""
    s = set()
    for bucket in ("key", "seq"):
        for f in g.get(bucket, []):
            for v in [f["v"]] + f.get("alt", []):
                for t in nums(v):
                    if len(t.replace(".", "")) >= 3:
                        s.add(t)
    return s


def classify(val, gt_set, boiler):
    """Тот же разбор, что в score.py: верное / печатный бланк / обрывок / искажение / выдумка."""
    if val in gt_set:
        return "верное"
    if val in boiler:
        return "бланк"
    d = val.replace(".", "")
    refs = [r.replace(".", "") for r in gt_set]
    if any(d in r or r in d for r in refs):
        return "обрывок"
    if any(lev(d, r) <= max(1, len(d) // 3) for r in refs):
        return "искажение"
    return "ВЫДУМКА"


def main():
    gt = {json.loads(l)["page"]: json.loads(l) for l in open(GT) if l.strip()}
    outs = {name: load(p) for name, p in MODELS.items()}

    # печатный бланк: длинное число, встретившееся у одной модели на >=3 страницах
    boiler = set()
    for name, pages in outs.items():
        seen = Counter()
        for t in pages.values():
            for v in set(longnums(t)):
                seen[v] += 1
        boiler |= {v for v, c in seen.items() if c >= 3}

    # ключевые поля эталона (строгий режим: >=3 цифр, уверенные)
    key_fields = {}
    for p, g in gt.items():
        ff = []
        for f in g["key"]:
            if f.get("conf") == "low":
                continue
            if sum(len(t.replace(".", "")) for t in nums(f["v"])) < 3:
                continue
            ff.append([f["v"]] + f.get("alt", []))
        key_fields[p] = ff

    rows = []
    detail = defaultdict(list)
    for k in (1, 2, 3):
        acc = Counter()
        found = total = 0
        for p, g in gt.items():
            present = {n: pages[p] for n, pages in outs.items() if p in pages}
            if len(present) < 2:
                continue
            votes = Counter()
            for n, text in present.items():
                for v in set(longnums(text)):
                    votes[v] += 1
            cons = {v for v, c in votes.items() if c >= k}
            gset = gt_longnums(g)
            for v in cons:
                cls = classify(v, gset, boiler)
                acc[cls] += 1
                if k == 2 and cls == "ВЫДУМКА":
                    detail["выдумки при k=2"].append(f"{p}:{v}")
            # полнота: поле найдено, если все его длинные числа в консенсусе
            for variants in key_fields[p]:
                total += 1
                ok = False
                for v in variants:
                    need = [t for t in nums(v) if len(t.replace(".", "")) >= 3]
                    if need and all(t in cons for t in need):
                        ok = True
                        break
                if ok:
                    found += 1
        emitted = sum(acc.values())
        good = acc["верное"]
        prec = good / emitted if emitted else 0
        rows.append((k, emitted, good, prec, acc["ВЫДУМКА"], acc["искажение"],
                     acc["обрывок"], acc["бланк"], found, total,
                     found / total if total else 0))

    print(f"{'k голосов':>10} {'выдано':>7} {'верных':>7} {'точность':>9} "
          f"{'выдумок':>8} {'искаж':>6} {'обрыв':>6} {'бланк':>6} {'полнота полей':>14}")
    for k, emitted, good, prec, inv, cor, frg, blk, found, total, rec in rows:
        print(f"{k:>10} {emitted:>7} {good:>7} {prec:>8.1%} "
              f"{inv:>8} {cor:>6} {frg:>6} {blk:>6}   {found}/{total} = {rec:>6.1%}")

    # покрытие страниц
    cov = Counter()
    for p in gt:
        cov[sum(1 for pages in outs.values() if p in pages)] += 1
    print(f"\nстраниц по числу моделей, покрывших её: {dict(sorted(cov.items()))}")
    for kk, vv in detail.items():
        print(f"{kk}: {', '.join(vv[:20])}")


if __name__ == "__main__":
    main()
