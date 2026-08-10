#!/usr/bin/env python3
"""Как часто в принятом теряется десятичный разделитель: «19,5» → «195».

Замечено глазами на карточках отложенного корпуса, посчитано здесь по эталону.

ЕДИНИЦА СЧЁТА — ЧТЕНИЕ ВЫРЕЗКИ, и пара «чтение ↔ поле» берётся ПО ИМЕНИ ПОЛЯ, а не
по совпадению цифр. Первая редакция этого замера считала иначе — шла от полей эталона
и искала на странице любое чтение с теми же цифрами — и дала 15 потерь из 25, то есть
60 %. Обе половины цифры оказались неверны:

  · ДВОЙНОЙ СЧЁТ. На карточке «мерзлота до» и «общая глубина» — одно и то же число,
    записанное на бланке ОДИН раз. Одно чтение попадало в счёт дважды: пять пар.
  · ЧУЖОЕ ПОЛЕ. «Азимут буровой линии 60°» имеет те же цифры, что «глубина 6,0 м»,
    а «на расстоянии 40 м» — те же, что «глубина 4,0». Модель прочитала их ВЕРНО,
    но замер записывал их в потери разделителя: ещё четыре случая.

Проверено глазами по строкам бланка — настоящих потерь шесть. Урок тот же, что во всём
проекте: совпадение цифр не значит «то же поле», и единицу счёта надо называть вслух.

Ни зона согласия, ни `verify.py` потерю не ловят: оба читателя теряют запятую
одинаково, а «32» проходит диапазон «глубина скважины, м» 0..2000. И `agree_values.py`
её не считает вовсе — он судит чтения с числом от трёх цифр, а у «3,2» их две.

  comma_loss.py <gt.jsonl> <главная.values.jsonl> <второй.values.jsonl> [--dir=img300]
"""
import json
import re
import sys
from collections import Counter


def dig(s):
    return re.sub(r"\D", "", str(s))


def has_sep(s):
    return bool(re.search(r"\d[.,]\d", str(s)))


def load(p):
    out = {}
    for line in open(p):
        if line.strip():
            o = json.loads(line)
            out.setdefault(o["page"], {})[tuple(o["box"])] = o["text"].strip()
    return out


def main():
    gt_path, a_path, b_path = sys.argv[1], sys.argv[2], sys.argv[3]
    d = "img300"
    for a in sys.argv[4:]:
        if a.startswith("--dir="):
            d = a.split("=")[1]

    from fieldmap import attach
    from values import extract

    gt = {}
    for line in open(gt_path):
        if line.strip():
            o = json.loads(line)
            gt[o["page"]] = o
    A, B = load(a_path), load(b_path)

    c = Counter()
    lost, kept, unnamed = [], [], []
    for page, g in sorted(gt.items()):
        if page not in A:
            continue
        acc = {k: A[page][k] for k in A[page]
               if k in B.get(page, {}) and A[page][k] and A[page][k] == B[page][k]}
        if not acc:
            continue
        path = f"{d}/{page}.jpg"
        vals, _ = extract(path)
        names = {r["box"]: r["field"]
                 for r in attach(path, [dict(box=v["box"], px=v["px"]) for v in vals])}
        by_field = {}
        for f in g.get("key", []):
            by_field.setdefault(f["f"], set()).add(str(f["v"]))

        for box, txt in acc.items():
            field = names.get(box)
            if not field or field not in by_field:
                # не названо — судить не о чем, но случай не прячем: без имени поля
                # потеря разделителя останется незамеченной и в бою
                if (not has_sep(txt)
                        and any(has_sep(v) and dig(v) == dig(txt)
                                for vs in by_field.values() for v in vs)):
                    c["не названо (возможна потеря)"] += 1
                    unnamed.append(f"{page} {txt!r}")
                continue
            want = {v for v in by_field[field] if dig(v) == dig(txt)}
            if not want:
                continue                     # чтение не про это значение поля
            if not any(has_sep(v) for v in want):
                continue                     # в эталоне целое — терять нечего
            c["десятичных значений прочитано"] += 1
            if has_sep(txt):
                c["  разделитель сохранён"] += 1
                kept.append(f"{page} {field} {txt!r}")
            else:
                c["  РАЗДЕЛИТЕЛЬ ПОТЕРЯН"] += 1
                lost.append(f"{page} {field}: эталон {sorted(want)} → {txt!r}")

    for k, v in c.items():
        print(f"  {k:34s} {v}")
    n = c["десятичных значений прочитано"]
    if n:
        print(f"\nпотеряно у {c['  РАЗДЕЛИТЕЛЬ ПОТЕРЯН']} из {n} названных = "
              f"{c['  РАЗДЕЛИТЕЛЬ ПОТЕРЯН'] / n:.0%}")
    for title, lst in (("потеряли", lost), ("сохранили", kept),
                       ("без имени поля, не судим", unnamed)):
        if lst:
            print(f"\n{title} ({len(lst)}):")
            for x in lst[:20]:
                print("   " + x)


if __name__ == "__main__":
    main()
