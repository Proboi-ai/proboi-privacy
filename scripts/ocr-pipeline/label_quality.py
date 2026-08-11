#!/usr/bin/env python3
"""Доля десятичных чисел с разделителем в обучающих метках — до/после починки.

Ориентир из хендоффа: эталон (как на самом деле) — 34,1 %, необработанные
метки согласия — 10,1 %. Если `fix_labels.py` подвинул метки к эталону не
испортив остальное — можно возвращаться к дообучению, если нет — не в этом
виде, как и раньше.

До/после считаются из ОДНОГО файла (`fix_labels.py` кладёт рядом `text_orig`
и `text`), чтобы поле «десятичное ли» бралось из ОДНОЙ и той же разметки —
иначе до и после были бы посчитаны по разным множествам строк.

  label_quality.py <train_pairs_fixed.jsonl>
"""
import json
import re
import sys

from sepfix import decimal_fields


def has_sep(text):
    return bool(re.search(r"\d[.,]\d", text))


def is_bare_number(text):
    digits = re.sub(r"\D", "", text)
    return len(digits) >= 2 and digits == re.sub(r"[.,]", "", text.strip())


def main():
    dec = decimal_fields()
    path = sys.argv[1]
    n = before = after = 0
    for line in open(path):
        if not line.strip():
            continue
        o = json.loads(line)
        if o.get("field") not in dec:
            continue
        orig, cur = o.get("text_orig", o["text"]), o["text"]
        if not is_bare_number(orig) and not has_sep(orig):
            continue
        n += 1
        before += has_sep(orig)
        after += has_sep(cur)

    print(f"{path}")
    print(f"  чисел в десятичных полях: {n}")
    print(f"  с разделителем ДО починки:  {before} ({before/max(1,n):.1%})")
    print(f"  с разделителем ПОСЛЕ:       {after} ({after/max(1,n):.1%})")
    print(f"  эталон (для сравнения):     34.1%")


if __name__ == "__main__":
    main()
