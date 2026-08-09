#!/usr/bin/env python3
"""Калибровка верификатора: где резать по уверенности и по количеству чернил.

Модель всегда что-то печатает. Вопрос не «как заставить её не ошибаться», а
«как узнать, когда ей верить». Здесь считается рабочая кривая:

    порог → сколько значений принято (покрытие) и какая доля из них верна (точность)

Метка на кроп берётся из эталона страницы: если выданное длинное число (>=3 цифр)
есть в эталоне — верно; если его там нет и оно не похоже на обрывок или на
типографское число бланка — ошибка. Кропы без длинных чисел (подписи, фамилии)
в расчёт точности не идут: про них эталон числами ничего не говорит.

Отдельно проверяется гипотеза «выдумки родятся на пустых кропах»: если это так,
дешёвый отказ ДО декодера (мало чернил → не звать модель) уберёт их без потери
полноты, и это лучший из возможных фильтров — он ничего не стоит.
"""
import json
import sys
from collections import Counter

from score import nums, lev


def longs(t):
    return [x for x in nums(t) if len(x.replace(".", "")) >= 3]


def load(path):
    return [json.loads(l) for l in open(path) if l.strip()]


def build_labels(values, gt):
    """→ список (запись, вердикт) для кропов, выдавших длинные числа."""
    # типографские числа бланка: длинное число, встреченное на >=3 разных страницах
    seen = Counter()
    per_page = {}
    for v in values:
        per_page.setdefault(v["page"], []).append(v)
    for pg, rows in per_page.items():
        for x in set(sum((longs(r["text"]) for r in rows), [])):
            seen[x] += 1
    boiler = {x for x, c in seen.items() if c >= 3}

    out = []
    for v in values:
        g = gt.get(v["page"])
        if not g:
            continue
        emitted = longs(v["text"])
        if not emitted:
            out.append((v, "без чисел"))
            continue
        gset = set()
        for b in ("key", "seq"):
            for f in g.get(b, []):
                for val in [f["v"]] + f.get("alt", []):
                    gset |= set(longs(val))
        refs = [r.replace(".", "") for r in gset]
        verdicts = []
        for x in emitted:
            d = x.replace(".", "")
            if x in gset:
                verdicts.append("верно")
            elif x in boiler:
                verdicts.append("бланк")
            elif any(d in r or r in d for r in refs):
                verdicts.append("обрывок")
            elif any(lev(d, r) <= max(1, len(d) // 3) for r in refs):
                verdicts.append("искажение")
            else:
                verdicts.append("выдумка")
        # вердикт кропа: лучшее, что он выдал
        rank = ["верно", "бланк", "обрывок", "искажение", "выдумка"]
        out.append((v, min(verdicts, key=rank.index)))
    return out


def curve(labelled, key, thresholds, label):
    print(f"\n{label}")
    print(f"{'порог':>10} {'принято':>8} {'верно':>7} {'точность':>9} "
          f"{'выдумок':>8} {'искаж':>6} {'потеряно верных':>16}")
    total_good = sum(1 for v, s in labelled if s == "верно")
    for th in thresholds:
        keep = [(v, s) for v, s in labelled if v[key] >= th and s != "без чисел"]
        good = sum(1 for _, s in keep if s in ("верно", "бланк"))
        inv = sum(1 for _, s in keep if s == "выдумка")
        cor = sum(1 for _, s in keep if s == "искажение")
        n = len(keep)
        right = sum(1 for _, s in keep if s == "верно")
        print(f"{th:>10} {n:>8} {right:>7} {good/n if n else 0:>8.1%} "
              f"{inv:>8} {cor:>6} {total_good-right:>16}")


def main():
    values = load(sys.argv[1] if len(sys.argv) > 1 else "out/kansall_clean.values.jsonl")
    gt = {json.loads(l)["page"]: json.loads(l) for l in open("gt/gt.jsonl")}
    lab = build_labels(values, gt)
    print(f"кропов всего: {len(values)}   с длинными числами: "
          f"{sum(1 for _, s in lab if s != 'без чисел')}")
    print("разбор вердиктов:", dict(Counter(s for _, s in lab)))

    curve(lab, "conf_mean", [0.0, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98],
          "ПО СРЕДНЕЙ УВЕРЕННОСТИ ТОКЕНА")
    curve(lab, "conf_min", [0.0, 0.1, 0.3, 0.5, 0.7, 0.8, 0.9],
          "ПО САМОМУ НЕУВЕРЕННОМУ ТОКЕНУ (ловит одну сомнительную цифру в числе)")
    curve(lab, "px", [0, 100, 200, 400, 800, 1500, 3000],
          "ПО КОЛИЧЕСТВУ ЧЕРНИЛ В КРОПЕ (отказ ДО декодера — самый дешёвый фильтр)")

    # прямая проверка гипотезы про пустые кропы
    inv = [v for v, s in lab if s == "выдумка"]
    good = [v for v, s in lab if s == "верно"]
    if inv and good:
        mi = sorted(x["px"] for x in inv)[len(inv) // 2]
        mg = sorted(x["px"] for x in good)[len(good) // 2]
        ci = sorted(x["conf_mean"] for x in inv)[len(inv) // 2]
        cg = sorted(x["conf_mean"] for x in good)[len(good) // 2]
        print(f"\nмедиана чернил:      выдумки {mi}   верные {mg}")
        print(f"медиана уверенности: выдумки {ci:.3f}   верные {cg:.3f}")


if __name__ == "__main__":
    main()
