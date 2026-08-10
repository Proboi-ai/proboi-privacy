#!/usr/bin/env python3
"""Как часто в принятом теряется десятичный разделитель: «19,5» → «195».

Замечено глазами на карточках отложенного корпуса, посчитано здесь по эталону.
Логика простая: берём значение эталона С разделителем и смотрим, прочитал ли кто-то
на этой странице те же ЦИФРЫ, но без разделителя.

Почему это отдельный замер, а не строка в `agree_values.py`. Тот судит только чтения,
где есть число из ≥3 цифр (`--min-digits=3`), а у «3,2» после снятия разделителя две
цифры — такие чтения в знаменатель точности не попадают вовсе. Класс ошибок, стоящий
множителя 10 на глубинах в метрах, оказался исключён из метрики по построению.

Ни зона согласия, ни `verify.py` его не ловят: оба читателя теряют запятую одинаково,
а «32» проходит диапазон «глубина скважины, м» 0..2000.

  comma_loss.py <gt.jsonl> <главная.values.jsonl> <второй.values.jsonl>
"""
import json
import re
import sys
from collections import Counter


def digits(s):
    return re.sub(r"\D", "", str(s))


def load(p):
    out = {}
    for line in open(p):
        if line.strip():
            o = json.loads(line)
            out.setdefault(o["page"], {})[tuple(o["box"])] = o["text"].strip()
    return out


gt = {}
for line in open(sys.argv[1]):
    if line.strip():
        o = json.loads(line)
        gt[o["page"]] = o
A, B = load(sys.argv[2]), load(sys.argv[3])

c = Counter()
lost, kept = [], []
for page, g in gt.items():
    acc = {k: A[page][k] for k in A.get(page, {})
           if k in B.get(page, {}) and A[page][k] and A[page][k] == B[page][k]}
    texts = list(acc.values())
    for f in g.get("key", []):
        v = str(f["v"])
        if not re.search(r"\d[.,]\d", v):
            continue
        c["полей с разделителем"] += 1
        d = digits(v)
        with_sep = [t for t in texts if digits(t) == d and re.search(r"\d[.,]\d", t)]
        without = [t for t in texts if digits(t) == d and not re.search(r"\d[.,]\d", t)]
        if with_sep:
            c["прочитано с разделителем"] += 1
            kept.append(f"{page} {f['f']}={v} → {with_sep[0]}")
        elif without:
            c["ПРОЧИТАНО БЕЗ РАЗДЕЛИТЕЛЯ"] += 1
            lost.append(f"{page} {f['f']}={v} → {without[0]!r}")
        else:
            c["цифры не совпали ни у кого"] += 1

for k, v in c.items():
    print(f"  {k:32s} {v}")
n = c["прочитано с разделителем"] + c["ПРОЧИТАНО БЕЗ РАЗДЕЛИТЕЛЯ"]
if n:
    print(f"\nиз принятых с верными цифрами разделитель потерян у "
          f"{c['ПРОЧИТАНО БЕЗ РАЗДЕЛИТЕЛЯ']} из {n} = "
          f"{c['ПРОЧИТАНО БЕЗ РАЗДЕЛИТЕЛЯ']/n:.0%}")
print("\nпотеряли:")
for x in lost:
    print("   " + x)
print("\nсохранили (первые 10):")
for x in kept[:10]:
    print("   " + x)
