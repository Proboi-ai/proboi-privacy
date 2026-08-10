#!/usr/bin/env python3
"""Молчание конвейера: три геометрические причины НЕ отдавать чтение как значение.

Задача 2 редакции 5 хендоффа: узкое место приёмки не модель, а то, что конвейер
не умеет молчать. На полном 302-строчном листе 121 принятое чтение (40 %) было
обрывком линовки или подписи, не значением ни в каком смысле. Все три причины
ниже — чистая геометрия, ни модели, ни повторного распознавания не требуют.

  1. ОБРЫВОК ЛИНОВКИ. Цветовое разделение (inklayer.split) неидеально: тонкий
     остаток печатной линии иногда просачивается в рукописный слой и после
     group() выглядит отдельным «значением» — тонкая горизонтальная полоса ровно
     на высоте известной линовки. slots.py уже ищет линовки в печатном слое для
     привязки к полю; здесь тот же список используется для отсева. Судим по
     НЕОБРЕЗАННОМУ ящику чернил (`inkbox` из values.extract), а не по вырезке
     с полями: после pad=14 любая вырезка формально не тоньше 28 px.
  2. ПОЛЕ ПОДПИСИ. «Геолог ___», «маркшейдер ___», «промывальщик ___», «бригадой
     ___» — печатные подписи перед росчерком фамилии, не перед числом. Модель на
     росчерке либо молчит, либо галлюцинирует правдоподобное имя; правильный
     ответ — не пытаться, отдать нейтральную метку «подпись» (см. новые правила
     в fieldmap.RULES).
  3. ЧТЕНИЕ БЕЗ ЦИФРЫ. Значений без единой цифры в этом бланке не бывает вовсе:
     все свободнотекстовые поля (характер пород, примечания) редко доживают до
     СОГЛАСИЯ двух голосов — они слишком разные, чтобы совпасть дословно, и в
     «принятое» почти не попадают (см. хендофф раздел «Непредвзятая проверка»).
     Значит любое принятое чтение без цифры — обрывок линовки или подписи,
     которого не поймал geometрический фильтр №1. Измерено дважды: на 15-стр.
     эталоне (STENDA) 201 такое чтение, ни одно не совпало ни с одним значением
     эталона этой страницы (harm=0); на 302-строчном held-out листе это ровно
     121 чтение — та самая доля «40 % принятого не значения» из хендоффа.
     Раньше здесь стояла проверка «только для числовых полей по имени» — она
     ловила лишь 16 из 121, потому что 105 из 121 вообще не получили имени поля
     (fieldmap не приписывает имена свободнотекстовым полям, а промежуточным
     обрывкам — тем более). Ограничение снято по измерению, не по догадке.

  silence.py <gt.jsonl> <главная.values.jsonl> <второй.values.jsonl> [--dir=img300]
"""
import json
import sys
from collections import Counter, defaultdict

SIGNATURE_FIELDS = {"подпись: геолог", "подпись: маркшейдер",
                     "подпись: промывальщик", "подпись: бригада"}


def ruling_fragment(v, rulings, tol_y=5, max_h=9, min_aspect=3.0):
    """True, если значение v — обрывок печатной линовки, просочившийся в рукопись."""
    inkbox = v.get("inkbox")
    if not inkbox:
        return False
    x0, y0, x1, y1 = inkbox
    h, w = y1 - y0, x1 - x0
    if h <= 0 or h > max_h or w / h < min_aspect:
        return False
    cy = (y0 + y1) / 2
    for (rx0, ry0, rx1, ry1) in rulings:
        if rx0 - tol_y <= x0 and x1 <= rx1 + tol_y and abs(cy - ry0) <= tol_y:
            return True
    return False


def is_signature(field):
    return field in SIGNATURE_FIELDS


def no_digit(text):
    """Принятое чтение без единой цифры — на этом бланке не бывает значением:
    свободный текст почти никогда не доживает до согласия двух голосов
    (см. докстринг модуля), так что уцелевший бесцифровой текст — обрывок."""
    return not any(ch.isdigit() for ch in text)


def why_silent(v, field, text, rulings):
    """Единая точка входа: причина промолчать, или None если чтение — значение."""
    if ruling_fragment(v, rulings):
        return "линовка"
    if is_signature(field):
        return "подпись"
    if no_digit(text):
        return "без цифры"
    return None


def main():
    gt_path, a_path, b_path = sys.argv[1], sys.argv[2], sys.argv[3]
    d = "img300"
    for a in sys.argv[4:]:
        if a.startswith("--dir="):
            d = a.split("=")[1]

    from fieldmap import attach
    from slots import rulings as find_rulings
    from values import extract
    from inklayer import split

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
    pages = sorted(set(A) & set(B))

    c = Counter()
    silenced_examples = defaultdict(list)
    harm = []          # эталонные значения, которые силенс отсёк бы — цена
    for page in pages:
        path = f"{d}/{page}.jpg"
        vals, _ = extract(path)
        vbybox = {tuple(v["box"]): v for v in vals}
        names = {r["box"]: r["field"]
                 for r in attach(path, [dict(box=v["box"], px=v["px"]) for v in vals])}
        _, printed, _meta = split(path)
        import numpy as np
        rules = find_rulings(printed)

        # вред проверяем ШИРЕ, чем по имени поля: «нет цифры» силенсит и
        # чтения без имени поля вовсе (105 из 121 на held-out листе), а имени
        # поля там по определению нет — значит и `want[field]` пуст всегда.
        # Единственная надёжная проверка — совпадает ли текст с ЛЮБЫМ значением
        # эталона этой страницы, независимо от поля.
        want = defaultdict(set)
        page_values = set()
        if page in gt:
            for f in gt[page].get("key", []):
                want[f["f"]].add(str(f["v"]))
            for bucket in ("key", "seq"):
                for f in gt[page].get(bucket, []):
                    for x in [f["v"]] + f.get("alt", []):
                        page_values.add(str(x).strip())

        acc = {k: A[page][k] for k in A[page] if k in B[page] and A[page][k] == B[page][k]}
        for box, text in acc.items():
            if not text:
                continue
            field = names.get(box)
            v = vbybox.get(box, dict(inkbox=None))
            reason = why_silent(v, field, text, rules)
            c["принято: всего"] += 1
            if reason:
                c[f"отсечено: {reason}"] += 1
                silenced_examples[reason].append(f"{page} {field or '—'}: {text!r}")
                if text.strip() in page_values:
                    harm.append(f"{reason}: {page} {field or '—'}={text!r} — БЫЛО В ЭТАЛОНЕ")
            else:
                c["осталось значением"] += 1

    print(f"страниц: {len(pages)}")
    for k in sorted(c):
        print(f"  {k:34s} {c[k]}")
    print()
    for reason, ex in silenced_examples.items():
        print(f"отсечено как «{reason}» ({len(ex)}):")
        for x in ex[:15]:
            print("   " + x)
        print()
    print(f"вред (эталонное значение отсечено): {len(harm)}")
    for h in harm:
        print("   !!! " + h)


if __name__ == "__main__":
    main()
