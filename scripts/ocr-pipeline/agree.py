#!/usr/bin/env python3
"""Зона согласия: сколько полей закрывается, если верить только тому, что подтвердили K читателей.

Обобщение consensus.py: там список моделей был вшит в код и правился руками под каждый
замер — так измеренную цифру нельзя воспроизвести через день. Здесь читатели задаются
аргументами, а состав прогона печатается в шапке отчёта.

  agree.py <gt.jsonl> имя=out/файл.jsonl [имя=...] [--min-digits=3]

Считаем по «длинным» числам (>=3 цифр): однозначные номера пунктов бланка ловятся
случайно в любом месте вывода и раздувают полноту. Разбор выданного значения —
тот же, что в score.py (верное / печатный бланк / обрывок / искажение / выдумка),
чтобы цифры этого отчёта стыковались с одиночными замерами.

Две вещи, ради которых отчёт устроен именно так:

1. ОДИНОЧНАЯ СТРОКА КАЖДОГО ЧИТАТЕЛЯ печатается рядом с зоной согласия. Механика
   зоны — произведение точностей участников, и без одиночных цифр нельзя понять,
   кто именно держит покрытие внизу.
2. ПОКРЫТИЕ И ТОЧНОСТЬ РАЗНЕСЕНЫ. Точность считается по выданным значениям,
   покрытие — по полям эталона. Это разные знаменатели, и их регулярно путают.
"""
import json
import sys
from collections import Counter, defaultdict
from itertools import combinations

from score import lev, nums


def longnums(text, mind):
    return [t for t in nums(text) if len(t.replace(".", "")) >= mind]


def load(path):
    out = {}
    for line in open(path):
        if line.strip():
            o = json.loads(line)
            out[o["page"]] = o["text"]
    return out


def gt_longnums(g, mind):
    s = set()
    for bucket in ("key", "seq"):
        for f in g.get(bucket, []):
            for v in [f["v"]] + f.get("alt", []):
                s |= {t for t in nums(v) if len(t.replace(".", "")) >= mind}
    return s


def classify(val, gt_set, boiler):
    """Тот же разбор, что в score.py: верное / бланк / обрывок / искажение / выдумка."""
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


def key_fields(gt, mind):
    """Поля эталона, по которым считается покрытие: уверенные и достаточно длинные."""
    out = {}
    for p, g in gt.items():
        ff = []
        for f in g["key"]:
            if f.get("conf") == "low":
                continue
            if sum(len(t.replace(".", "")) for t in nums(f["v"])) < mind:
                continue
            ff.append([f["v"]] + f.get("alt", []))
        out[p] = ff
    return out


def tally(pages_by_reader, gt, fields, boiler, mind, k, names):
    """Одна строка отчёта: голосуем среди names, требуем k голосов."""
    acc = Counter()
    found = total = 0
    fabricated = []
    for p, g in gt.items():
        present = [n for n in names if p in pages_by_reader[n]]
        if len(present) < k:
            continue
        votes = Counter()
        for n in present:
            for v in set(longnums(pages_by_reader[n][p], mind)):
                votes[v] += 1
        cons = {v for v, c in votes.items() if c >= k}
        gset = gt_longnums(g, mind)
        for v in cons:
            cls = classify(v, gset, boiler)
            acc[cls] += 1
            if cls == "ВЫДУМКА":
                fabricated.append(f"{p}:{v}")
        for variants in fields[p]:
            total += 1
            for v in variants:
                need = [t for t in nums(v) if len(t.replace(".", "")) >= mind]
                if need and all(t in cons for t in need):
                    found += 1
                    break
    emitted = sum(acc.values())
    return dict(emitted=emitted, good=acc["верное"],
                prec=acc["верное"] / emitted if emitted else 0.0,
                inv=acc["ВЫДУМКА"], cor=acc["искажение"], frg=acc["обрывок"],
                blk=acc["бланк"], found=found, total=total,
                cov=found / total if total else 0.0, fabricated=fabricated)


def row(label, r):
    return (f"{label:34s}{r['emitted']:7d}{r['good']:7d}{r['prec']:9.1%}"
            f"{r['inv']:8d}{r['cor']:6d}{r['frg']:6d}{r['blk']:6d}"
            f"   {r['found']:3d}/{r['total']:<3d} = {r['cov']:6.1%}")


def main():
    mind = 3
    args = []
    for a in sys.argv[1:]:
        if a.startswith("--min-digits="):
            mind = int(a.split("=")[1])
        else:
            args.append(a)
    gt_path, specs = args[0], args[1:]
    if len(specs) < 2:
        sys.exit("нужно минимум два читателя: agree.py gt.jsonl имя=путь имя=путь ...")

    gt = {json.loads(l)["page"]: json.loads(l) for l in open(gt_path) if l.strip()}
    readers = {}
    for s in specs:
        name, path = s.split("=", 1)
        readers[name] = load(path)
    names = list(readers)

    # печатный бланк: длинное число, встреченное ОДНИМ читателем на >=3 страницах.
    # Считается по всем участникам прогона — как в consensus.py, иначе цифры разъедутся.
    boiler = set()
    for pages in readers.values():
        seen = Counter()
        for t in pages.values():
            for v in set(longnums(t, mind)):
                seen[v] += 1
        boiler |= {v for v, c in seen.items() if c >= 3}

    fields = key_fields(gt, mind)
    npages = {n: sum(1 for p in gt if p in readers[n]) for n in names}
    print(f"эталон: {len(gt)} страниц · длинные числа: >={mind} цифр · "
          f"печатных чисел бланка отфильтровано: {len(boiler)}")
    print("читатели: " + ", ".join(f"{n} ({npages[n]} стр)" for n in names))
    print()
    hdr = f"{'':34s}{'выдано':>7}{'верных':>7}{'точность':>9}{'выдум':>8}{'искаж':>6}{'обрыв':>6}{'бланк':>6}   покрытие полей"
    print(hdr)
    print("— поодиночке " + "—" * (len(hdr) - 13))
    for n in names:
        print(row(n, tally(readers, gt, fields, boiler, mind, 1, [n])))
    print("— парами (согласие двоих) " + "—" * (len(hdr) - 26))
    pairs = []
    for a, b in combinations(names, 2):
        r = tally(readers, gt, fields, boiler, mind, 2, [a, b])
        pairs.append((f"{a} + {b}", r))
        print(row(f"{a} + {b}", r))
    if len(names) >= 3:
        print("— все вместе " + "—" * (len(hdr) - 13))
        for k in range(2, len(names) + 1):
            r = tally(readers, gt, fields, boiler, mind, k, names)
            print(row(f"{len(names)} читателей, k>={k}", r))
    print()
    for label, r in pairs:
        if r["fabricated"]:
            print(f"выдумки [{label}]: {', '.join(r['fabricated'][:12])}")


if __name__ == "__main__":
    main()
