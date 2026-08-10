#!/usr/bin/env python3
"""Что даёт доменный верификатор, когда у значений появились имена полей.

До сих пор `verify.py` проверялся только на эталоне: «0 ложных отказов на 211 полях».
Это ответ на половину вопроса. Вторая половина — сколько НЕВЕРНЫХ чтений он снимает
из того, что конвейер уже принял без человека. Без имён полей его нельзя было даже
запустить на выводе конвейера, теперь можно.

Считаем на принятом (два читателя совпали) и с присвоенным именем. «Верно» —
чтение равно значению эталона для ЭТОГО поля на этой странице.

  верно + ok        — правильно пропущено
  верно + отказ     — ЛОЖНЫЙ ОТКАЗ, цена правила
  неверно + отказ   — поймано, ради чего всё
  неверно + ok      — пропущено

  verify_gain.py <gt.jsonl> <главная.values.jsonl> <второй.values.jsonl> [--dir=img300]
"""
import json
import sys
from collections import Counter, defaultdict

from fieldmap import attach
from score_fields import key
from verify import check_field, observed_sets


def load(p):
    out = {}
    for line in open(p):
        if line.strip():
            o = json.loads(line)
            out[(o["page"], tuple(o["box"]))] = o["text"].strip()
    return out


def main():
    gt_path, a_path, b_path = sys.argv[1], sys.argv[2], sys.argv[3]
    d = "img300"
    for a in sys.argv[4:]:
        if a.startswith("--dir="):
            d = a.split("=")[1]

    rows = [json.loads(l) for l in open(gt_path) if l.strip()]
    gt = {o["page"]: o for o in rows}
    sets = observed_sets(rows)

    A, B = load(a_path), load(b_path)
    accepted = {k: A[k] for k in A if k in B and A[k] and A[k] == B[k]}

    per_page = defaultdict(list)
    for (pg, box), txt in accepted.items():
        per_page[pg].append((box, txt))

    tally = Counter()
    caught, false_rej = [], []
    for pg, items in sorted(per_page.items()):
        if pg not in gt:
            continue
        named = {r["box"]: r["field"]
                 for r in attach(f"{d}/{pg}.jpg", [dict(box=b) for b, _ in items])}
        true_vals = defaultdict(set)
        for f in gt[pg].get("key", []):
            true_vals[f["f"]].add(key(f["v"]))
        for box, txt in items:
            field = named.get(box)
            if not field:
                tally["без имени"] += 1
                continue
            if field not in true_vals:
                tally["поля нет в эталоне"] += 1
                continue
            ok_read = key(txt) in true_vals[field]
            verdict, why = check_field(field, txt, sets)
            passed = verdict == "ok"
            tally[("верно" if ok_read else "неверно") + " + " +
                  ("ok" if passed else "отказ")] += 1
            if ok_read and not passed:
                false_rej.append(f"{pg}: {field} = {txt!r} — {verdict}, {why}")
            if not ok_read and not passed:
                caught.append(f"{pg}: {field} = {txt!r} — {verdict}, {why}")

    judged = sum(v for k, v in tally.items() if "+" in k)
    good = tally["верно + ok"] + tally["верно + отказ"]
    bad = tally["неверно + ok"] + tally["неверно + отказ"]
    print(f"принято чтений: {len(accepted)} · с именем и полем из эталона: {judged}")
    print(f"  без имени поля       : {tally['без имени']}")
    print(f"  имя есть, поля нет в эталоне: {tally['поля нет в эталоне']}")
    print()
    for k in ("верно + ok", "верно + отказ", "неверно + отказ", "неверно + ok"):
        print(f"  {k:18s} {tally[k]:4d}")
    print()
    if bad:
        print(f"ловит неверных: {tally['неверно + отказ']} из {bad} = "
              f"{tally['неверно + отказ']/bad:.0%}")
    if good:
        print(f"ложных отказов: {tally['верно + отказ']} из {good} = "
              f"{tally['верно + отказ']/good:.1%}")
    if caught:
        print(f"\nпойманные ошибки ({len(caught)}):")
        for c in caught[:20]:
            print("   " + c)
    if false_rej:
        print(f"\nЛОЖНЫЕ ОТКАЗЫ ({len(false_rej)}):")
        for c in false_rej[:20]:
            print("   " + c)


if __name__ == "__main__":
    main()
