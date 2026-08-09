#!/usr/bin/env python3
"""Зона согласия НА УРОВНЕ ВЫРЕЗКИ: два читателя прочли ОДНУ И ТУ ЖЕ вырезку одинаково.

Это не то же самое, что согласие по странице. Там число засчитывалось, если
встретилось где угодно в выводе обоих; здесь требуется совпасть на конкретной
вырезке. Именно этот фильтр отбирал псевдо-метки в harvest.py, и именно его
измеренная точность (95,5 % на 44 совпавших чтениях) стоит в отчёте.

ЕДИНИЦА СЧЁТА — ЧТЕНИЕ ВЫРЕЗКИ, не различное число на странице. Разница не
косметическая: одно и то же число, прочитанное на трёх вырезках, — это три
чтения и одно число, и цифры расходятся почти вдвое. Отчётная цифра 95,5 %
воспроизводится ровно при счёте по чтениям (42 из 44), поэтому так и считаем.

ДВЕ КОЛОНКИ ТОЧНОСТИ, потому что «верно» здесь значит два разных дела:
  точность фильтра — прочитано верно, включая типографские числа самого бланка
                     (их модель тоже читает, и читает правильно). Это цифра из
                     отчёта, ею меряют пригодность фильтра для псевдо-меток.
  по эталону       — прочитано верно И это значение из эталона, то есть польза
                     для дела. Печатные числа бланка сюда не идут.
Смешение этих двух — готовая ошибка измерителя: постраничный третий голос
подтверждает печатные числа охотнее рукописных и раздувает первую колонку.

Третий голос — постраничный (PaddleOCR-VL): он разбирает лист целиком и на
вырезки не разложен, поэтому голосует ВХОЖДЕНИЕМ — подтверждает чтение, если все
его длинные числа нашлись в тексте страницы. Это слабее дословного совпадения
вырезки, и в отчёте такие строки помечены отдельно.

  agree_values.py <gt.jsonl> имя=out/x.values.jsonl [имя=...] [--page имя=out/y.jsonl]
                  [--px=0] [--min-digits=3]
"""
import json
import sys
from collections import Counter, defaultdict
from itertools import combinations

from score import lev, nums

ORDER = ["верное", "бланк", "обрывок", "искажение", "ВЫДУМКА"]


def longnums(text, mind):
    return [t for t in nums(text) if len(t.replace(".", "")) >= mind]


def load_values(path):
    """→ {(страница, рамка): запись}. Рамка одна и та же у всех моделей: нарезка
    детерминирована и от модели не зависит, поэтому ключ соединения надёжен."""
    out = {}
    for line in open(path):
        if line.strip():
            o = json.loads(line)
            out[(o["page"], tuple(o["box"]))] = o
    return out


def load_pages(path):
    return {json.loads(l)["page"]: json.loads(l)["text"]
            for l in open(path) if l.strip()}


def gt_longnums(g, mind):
    s = set()
    for bucket in ("key", "seq"):
        for f in g.get(bucket, []):
            for v in [f["v"]] + f.get("alt", []):
                s |= {t for t in nums(v) if len(t.replace(".", "")) >= mind}
    return s


def classify(val, gt_set, boiler):
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


def judge(accepted, gt, fields, boiler, mind):
    """accepted: {(страница, рамка): текст} — что конвейер принял бы без человека."""
    acc = Counter()
    fab = []
    for (p, _box), text in accepted.items():
        ln = longnums(text, mind)
        if not ln:
            continue          # чтение без длинных чисел эталон числами не судит
        gset = gt_longnums(gt[p], mind)
        cls = [classify(v, gset, boiler) for v in ln]
        worst = next(c for c in reversed(ORDER) if c in cls)
        acc[worst] += 1
        if worst == "ВЫДУМКА":
            fab.append(f"{p}:{text}")
    n = sum(acc.values())

    by_page = defaultdict(set)
    for (p, _box), text in accepted.items():
        by_page[p] |= set(longnums(text, mind))
    found = total = 0
    for p, variants_list in fields.items():
        cons = by_page.get(p, set())
        for variants in variants_list:
            total += 1
            for v in variants:
                need = [t for t in nums(v) if len(t.replace(".", "")) >= mind]
                if need and all(t in cons for t in need):
                    found += 1
                    break
    return dict(n=n, accepted=len(accepted),
                prec_filter=(acc["верное"] + acc["бланк"]) / n if n else 0.0,
                prec_gt=acc["верное"] / n if n else 0.0,
                inv=acc["ВЫДУМКА"], cor=acc["искажение"], frg=acc["обрывок"],
                blk=acc["бланк"], good=acc["верное"],
                found=found, total=total, cov=found / total if total else 0.0,
                fab=fab)


HDR = (f"{'':40s}{'чтений':>7}{'точн.фильтра':>13}{'по эталону':>11}"
       f"{'выдум':>7}{'искаж':>6}{'обрыв':>6}{'бланк':>6}   покрытие полей")


def row(label, r):
    return (f"{label:40s}{r['n']:7d}{r['prec_filter']:12.1%}{r['prec_gt']:11.1%}"
            f"{r['inv']:7d}{r['cor']:6d}{r['frg']:6d}{r['blk']:6d}"
            f"   {r['found']:3d}/{r['total']:<3d} = {r['cov']:6.1%}")


def contains(page_text, reading, mind):
    """Постраничный читатель подтверждает чтение, если ВСЕ его длинные числа есть
    в тексте страницы. Чтения без длинных чисел он подтвердить не может."""
    need = longnums(reading, mind)
    if not need:
        return False
    have = set(longnums(page_text, mind))
    return all(t in have for t in need)


def main():
    mind, px_min = 3, 0
    specs, page_specs = [], []
    take_page = False
    for a in sys.argv[1:]:
        if a == "--page":
            take_page = True
        elif a.startswith("--min-digits="):
            mind = int(a.split("=")[1])
        elif a.startswith("--px="):
            px_min = int(a.split("=")[1])
        elif take_page:
            page_specs.append(a)
            take_page = False
        else:
            specs.append(a)
    gt_path, specs = specs[0], specs[1:]

    gt = {json.loads(l)["page"]: json.loads(l) for l in open(gt_path) if l.strip()}
    readers = {n: load_values(p) for n, p in (s.split("=", 1) for s in specs)}
    pagers = {n: load_pages(p) for n, p in (s.split("=", 1) for s in page_specs)}
    names = list(readers)

    # печатный бланк: длинное число, встреченное одним читателем на >=3 страницах
    boiler = set()
    for vals in readers.values():
        per = defaultdict(set)
        for (p, _b), o in vals.items():
            per[p] |= set(longnums(o["text"], mind))
        c = Counter()
        for p, vs in per.items():
            for v in vs:
                c[v] += 1
        boiler |= {v for v, k in c.items() if k >= 3}
    for pages in pagers.values():
        c = Counter()
        for t in pages.values():
            for v in set(longnums(t, mind)):
                c[v] += 1
        boiler |= {v for v, k in c.items() if k >= 3}

    fields = key_fields(gt, mind)
    boxes = set.intersection(*[set(v) for v in readers.values()])
    boxes = {b for b in boxes if b[0] in gt}
    if px_min:
        boxes = {b for b in boxes
                 if all(readers[n][b].get("px", 0) >= px_min for n in names)}
    print(f"эталон: {len(gt)} страниц · вырезок общих у всех читателей: {len(boxes)}"
          f"{f' (чернил >= {px_min} px)' if px_min else ''} · длинные числа: "
          f">={mind} цифр · печатных чисел бланка отфильтровано: {len(boiler)}")
    print("по вырезкам: " + ", ".join(names)
          + ("; постранично, голос вхождением: " + ", ".join(pagers) if pagers else ""))
    print()
    print(HDR)

    print("— поодиночке " + "—" * (len(HDR) - 13))
    for n in names:
        solo = {b: readers[n][b]["text"].strip() for b in boxes
                if readers[n][b]["text"].strip()}
        print(row(n, judge(solo, gt, fields, boiler, mind)))

    print("— согласие двух вырезочных читателей " + "—" * (len(HDR) - 37))
    for a, b in combinations(names, 2):
        acc = {box: readers[a][box]["text"].strip() for box in boxes
               if readers[a][box]["text"].strip()
               and readers[a][box]["text"].strip() == readers[b][box]["text"].strip()}
        r = judge(acc, gt, fields, boiler, mind)
        print(row(f"{a} == {b}", r))
        if r["fab"]:
            print(f"      выдумки: {', '.join(r['fab'][:8])}")

    for pn, pages in pagers.items():
        print(f"— третий голос {pn}, постранично " + "—" * (len(HDR) - 33))
        for a in names:
            acc = {box: readers[a][box]["text"].strip() for box in boxes
                   if readers[a][box]["text"].strip()
                   and contains(pages.get(box[0], ""), readers[a][box]["text"].strip(), mind)}
            print(row(f"{a} + {pn}", judge(acc, gt, fields, boiler, mind)))
        for a, b in combinations(names, 2):
            pair = {box: readers[a][box]["text"].strip() for box in boxes
                    if readers[a][box]["text"].strip()
                    and readers[a][box]["text"].strip() == readers[b][box]["text"].strip()}
            # строже: пара И подтверждение страницей
            acc = {k: v for k, v in pair.items() if contains(pages.get(k[0], ""), v, mind)}
            print(row(f"{a} == {b}, подтв. {pn}", judge(acc, gt, fields, boiler, mind)))
            # шире: пара ИЛИ подтверждение страницей — здесь и живёт рост покрытия
            acc = dict(pair)
            for box in boxes:
                ta = readers[a][box]["text"].strip()
                if ta and contains(pages.get(box[0], ""), ta, mind):
                    acc[box] = ta
            r = judge(acc, gt, fields, boiler, mind)
            print(row(f"{a}=={b} ИЛИ {a}+{pn}", r))
            if r["fab"]:
                print(f"      выдумки: {', '.join(r['fab'][:8])}")


if __name__ == "__main__":
    main()
