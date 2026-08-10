#!/usr/bin/env python3
"""Правки чтения, которые можно сделать ЗНАЯ ИМЯ ПОЛЯ, — и замер каждой отдельно.

Смысл в том, что имя поля переводит догадку в правило. «о» — это буква или ноль?
Вне контекста не ответить; в поле «мерзлота от, м» ответ единственный. Так же с
хвостом единицы: «7.0 м» в поле, где единица напечатана на бланке, — это «7,0», а
не другое значение.

Каждая правка меряется ПОРОЗНЬ и в обе стороны: сколько чтений стало верными и
сколько сломалось. Правка, у которой вред не измерен, в конвейер не идёт — в этом
проекте так уже теряли по пять пунктов, не заметив.

  postfix.py <gt.jsonl> <главная.values.jsonl> <второй.values.jsonl> [--dir=img300]
"""
import json
import re
import sys
from collections import Counter, defaultdict

from sepfix import decimal_fields, separator

# Что путается с цифрами в рукописи. Список короткий и только про те знаки, которые
# в числовом поле не могут значить ничего другого.
CONFUSE = str.maketrans({"о": "0", "О": "0", "o": "0", "O": "0",
                         "з": "3", "З": "3", "б": "6", "l": "1", "I": "1"})
UNIT_TAIL = re.compile(r"[\s.,]*(мм|м|%|град|гр)\.?$", re.I)


def numeric_fields():
    """Поля, где значение — число. Берём из verify.SPECS, а не из головы."""
    from verify import DIAM_FIELDS, SPECS
    out = {f for f, s in SPECS.items() if "re" in s and s.get("kind") != "date"}
    return out | set(DIAM_FIELDS)


def fix_unit(text, field, num):
    """«7.0 м» → «7.0»: единица напечатана на бланке, в значении ей делать нечего."""
    if field not in num:
        return text, None
    new = UNIT_TAIL.sub("", text).strip()
    return (new, "снят хвост единицы") if new != text and new else (text, None)


def fix_confuse(text, field, num):
    """«о» → «0» там, где поле числовое и всё остальное — цифры."""
    if field not in num:
        return text, None
    new = text.translate(CONFUSE)
    if new == text:
        return text, None
    # правим только если ПОСЛЕ правки получилось честное число: иначе это не
    # спутанная цифра, а настоящий текст («рыхлые», подпись)
    return (new, "буква вместо цифры") if re.fullmatch(r"[\d.,\-]+", new) else (text, None)


def fix_sep(text, field, dec, crop):
    """Потерянный десятичный разделитель — по чернилам (см. sepfix.py)."""
    if field not in dec or re.search(r"\d[.,]\d", text):
        return text, None
    digits = re.sub(r"\D", "", text)
    if len(digits) < 2 or digits != text.strip() or crop is None:
        return text, None
    pos = separator(crop, len(digits))
    if pos is None or not (0 < pos < len(digits)):
        return text, None
    return f"{digits[:pos]},{digits[pos:]}", "вернули запятую по чернилам"


def key(v):
    return re.sub(r"[^0-9]", "", str(v).replace(",", ".").replace(" ", "")) or str(v).strip().lower()


def same(a, b):
    na = str(a).replace(",", ".").replace(" ", "").rstrip(".")
    nb = str(b).replace(",", ".").replace(" ", "").rstrip(".")
    return na.lower() == nb.lower()


def main():
    gt_path, a_path, b_path = sys.argv[1], sys.argv[2], sys.argv[3]
    d = "img300"
    for a in sys.argv[4:]:
        if a.startswith("--dir="):
            d = a.split("=")[1]

    from fieldmap import attach
    from values import extract

    num, dec = numeric_fields(), decimal_fields()
    gt = {}
    for line in open(gt_path):
        if line.strip():
            o = json.loads(line)
            gt[o["page"]] = o

    def load(p):
        out = defaultdict(dict)
        for line in open(p):
            if line.strip():
                o = json.loads(line)
                out[o["page"]][tuple(o["box"])] = o["text"].strip()
        return out

    A, B = load(a_path), load(b_path)
    c = Counter()
    changes = defaultdict(list)
    for page, g in sorted(gt.items()):
        acc = {k: A[page][k] for k in A.get(page, {})
               if k in B.get(page, {}) and A[page][k] and A[page][k] == B[page][k]}
        if not acc:
            continue
        path = f"{d}/{page}.jpg"
        vals, _ = extract(path)
        crops = {tuple(v["box"]): v["crop"] for v in vals}
        names = {r["box"]: r["field"]
                 for r in attach(path, [dict(box=v["box"], px=v["px"]) for v in vals])}
        want = defaultdict(set)
        for f in g.get("key", []):
            want[f["f"]].add(str(f["v"]))

        for box, txt in acc.items():
            field = names.get(box)
            if not field or field not in want:
                continue
            was = any(same(txt, v) for v in want[field])
            cur, tags = txt, []
            for step, fn in (("единица", lambda t: fix_unit(t, field, num)),
                             ("буква→цифра", lambda t: fix_confuse(t, field, num)),
                             ("запятая", lambda t: fix_sep(t, field, dec, crops.get(box)))):
                new, why = fn(cur)
                if why:
                    tags.append(step)
                    cur = new
            if not tags:
                continue
            now = any(same(cur, v) for v in want[field])
            tag = "+".join(tags)
            c[f"{tag}: всего"] += 1
            if not was and now:
                c[f"{tag}: ПОЧИНИЛО"] += 1
                changes["починило"].append(f"{page} {field}: {txt!r} → {cur!r}")
            elif was and not now:
                c[f"{tag}: СЛОМАЛО"] += 1
                changes["сломало"].append(f"{page} {field}: {txt!r} → {cur!r} "
                                          f"(эталон {sorted(want[field])})")
            else:
                c[f"{tag}: без разницы"] += 1

    for k in sorted(c):
        print(f"  {k:34s} {c[k]}")
    for t, lst in changes.items():
        print(f"\n{t} ({len(lst)}):")
        for x in lst[:20]:
            print("   " + x)


if __name__ == "__main__":
    main()
