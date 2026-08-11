#!/usr/bin/env python3
"""Вернуть потерянную десятичную запятую по ЧЕРНИЛАМ, а не по догадке.

Задача. Принятое чтение «32» вместо «3,2» — ошибка в десять раз на глубине в метрах,
и её не ловит ничто: оба читателя теряют разделитель одинаково и соглашаются, правило
диапазона «32» пропускает, а отчётная метрика такие значения вообще не считает
(порог «число от трёх цифр» — у «3,2» их две). Замер по эталону: разделитель потерян
у 15 из 25 десятичных значений, то есть у 60 %.

Почему чинить надо не текстом, а картинкой. Соседи по бланку не спасают: на одной
карточке «мерзлота до» и «общая глубина» — одно и то же число, и запятую теряют ОБА
чтения сразу. Правила тоже молчат: и «3,2», и «32» — законная глубина. А вот в самих
чернилах разделитель есть — модель его видит и не печатает. Значит спрашивать надо
чернила.

Как. В вырезке ищем связные компоненты (те же, что режут значение, но с порогом
поменьше — запятая мелкая и в отбор ядер не попадает). Цифры — крупные компоненты,
по ним берём высоту и линию письма. Разделитель — маленький компонент, который сидит
НИЗКО (на линии письма или под ней), мал по обеим сторонам и стоит МЕЖДУ двумя
цифрами. Нашли такой, а в тексте разделителя нет — вставляем на его место, считая
цифры слева.

Осторожность в две стороны. Правка применяется только к полям, где десятичное
значение осмысленно (`verify.SPECS`, шаблон с дробной частью), и только когда цифры
модели совпали по количеству с цифровыми компонентами. Иначе мы бы «чинили» номера
скважин и диаметры, где запятой отродясь не было.

⚠️ **ГЕЙТ ПО ИМЕНИ ПОЛЯ ОБЯЗАТЕЛЕН, без него точность около 70 %.** Проверено:
на обучающих метках (`train_pairs.jsonl`, имён полей там нет) детектор нашёл 217
«потерянных запятых» из 1667 голых чисел, но глазами из 27 показанных верны около 15.
Врёт он на трёхзначных диаметрах — «151 → 1,51», «132 → 1,32», «147 → 1,47»: у
единицы есть засечка внизу, и она проходит по всем признакам запятой. С гейтом на
десятичные поля таких значений не бывает, и там замер дал 5 исправлений из 5 верных
при нуле испорченных. **Не применять к меткам обучения, пока у них нет имени поля.**

  sepfix.py <gt.jsonl> <главная.values.jsonl> <второй.values.jsonl> [--dir=bench/img300]
"""
import json
import re
import sys
from collections import Counter

import numpy as np

from values import components, extract

# Поля, где дробная часть законна. Список берём из verify.SPECS, а не из головы:
# шаблон с [.,] значит, что значение бывает десятичным.
def decimal_fields():
    from verify import DEC, DIAM_FIELDS, SPECS
    out = {f for f, s in SPECS.items() if s.get("re") == DEC}
    return out - set(DIAM_FIELDS)


def separator(crop, n_digits):
    """→ позиция разделителя (сколько цифр слева) или None.

    Вырезка — слой рукописи: чернила чёрным (0) на белом (255). `n_digits` — сколько
    цифр напечатала модель; это и есть контекст, который отделяет цифры от всего
    остального. Брать «крупные компоненты» по высоте не годится: у «7,0м» буква «м»
    и хвостатая запятая попадают в ту же высоту, что цифры, оценка размера цифры
    съезжает, и знак теряется. Зато мы точно знаем, что цифр РОВНО столько, сколько
    их в тексте, — значит цифры это n самых жирных компонентов, остальное разбираем.
    """
    a = np.asarray(crop)
    comps = components(a < 128, min_px=3)
    if len(comps) < n_digits + 1 or n_digits < 2:
        return None                      # знаку между цифрами взяться неоткуда
    by_ink = sorted(comps, key=lambda c: -c[4])
    digits, small = by_ink[:n_digits], by_ink[n_digits:]
    dh = float(np.median([c[3] - c[1] for c in digits]))
    top = float(np.median([c[1] for c in digits]))
    for c in sorted(small, key=lambda c: c[0]):
        x0, y0, x1, y1, n = c
        w, h = x1 - x0, y1 - y0
        # Запятая узкая и НАЧИНАЕТСЯ НИЗКО — у самой линии письма. Проверять её
        # высоту бесполезно: с хвостом она бывает в полцифры. Зато «м», «мм» и
        # верхние росчерки начинаются высоко и отсеиваются именно этим.
        if w > 0.55 * dh or y0 < top + 0.6 * dh:
            continue
        # и не пылинка: трёхпиксельная крапина под нулём в «400» была принята за
        # запятую и превратила верное чтение в «4,00»
        if h < 0.15 * dh or n < 20:
            continue
        # «Между цифрами» — по ЦЕНТРАМ, а не по краям: запятая почти всегда заезжает
        # под предыдущую цифру (у «1,0» знак на x 29–46, единица на 14–46), и
        # требование строгого зазора отвергало почти все настоящие случаи.
        cx = (x0 + x1) / 2
        left = [g for g in digits if (g[0] + g[2]) / 2 < cx]
        right = [g for g in digits if (g[0] + g[2]) / 2 > cx]
        if left and right:
            return len(left)
    return None


def fix(text, crop, field, dec_fields):
    """→ (новый текст, почему) либо (text, None), если трогать нельзя.

    Ровно ДВЕ цифры, не «две и больше». Гейт по DIAM_FIELDS не универсален:
    на обучающих метках (11.08, `fix_labels.py`) «выход керна, %» = «100»
    (законные 100 % — самое частое значение поля) чинилось в «10,0» тем же
    механизмом, что раньше портил трёхзначные диаметры («151→1,51») — у
    среднего «0» засечка проходит по всем признакам запятой. Полей с этой
    болезнью в DIAM_FIELDS не было, значит дело не в списке полей, а в
    ДЛИНЕ числа. Проверено на живой партии: 7 из 7 верных на двузначных
    числах, 1 из 1 испорчен на трёхзначном — граница ровно там."""
    if field not in dec_fields:
        return text, None
    if re.search(r"\d[.,]\d", text):
        return text, None                # разделитель уже есть
    digits = re.sub(r"\D", "", text)
    if len(digits) != 2 or digits != text.strip():
        return text, None                # не голое двузначное число — не наше дело
    pos = separator(crop, len(digits))
    if pos is None or not (0 < pos < len(digits)):
        return text, None
    return f"{digits[:pos]},{digits[pos:]}", f"чернила: знак после {pos}-й цифры"


def main():
    gt_path, a_path, b_path = sys.argv[1], sys.argv[2], sys.argv[3]
    d = "bench/img300"
    for a in sys.argv[4:]:
        if a.startswith("--dir="):
            d = a.split("=")[1]

    from fieldmap import attach
    dec = decimal_fields()
    gt = {}
    for line in open(gt_path):
        if line.strip():
            o = json.loads(line)
            gt[o["page"]] = o

    def load(p):
        out = {}
        for line in open(p):
            if line.strip():
                o = json.loads(line)
                out.setdefault(o["page"], {})[tuple(o["box"])] = o["text"].strip()
        return out

    A, B = load(a_path), load(b_path)
    c = Counter()
    good, harm, missed = [], [], []
    for page in sorted(gt):
        if page not in A:
            continue
        acc = {k: A[page][k] for k in A[page]
               if k in B.get(page, {}) and A[page][k] and A[page][k] == B[page][k]}
        path = f"{d}/{page}.jpg"
        vals, _ = extract(path)
        crops = {tuple(v["box"]): v["crop"] for v in vals}
        names = {r["box"]: r["field"]
                 for r in attach(path, [dict(box=v["box"], px=v["px"]) for v in vals])}
        # значения эталона на странице: цифры → есть ли у них разделитель
        want = {}
        for f in gt[page].get("key", []):
            want.setdefault(re.sub(r"\D", "", str(f["v"])), set()).add(str(f["v"]))
        for box, txt in acc.items():
            crop = crops.get(box)
            if crop is None:
                continue
            field = names.get(box)
            new, why = fix(txt, crop, field, dec)
            if new == txt:
                # не тронули — но надо ли было?
                dg = re.sub(r"\D", "", txt)
                if (field in dec and dg in want
                        and any(re.search(r"\d[.,]\d", v) for v in want[dg])
                        and not re.search(r"\d[.,]\d", txt)):
                    c["ПРОПУЩЕНО (надо было чинить)"] += 1
                    missed.append(f"{page} {field} {txt!r} ← эталон {want[dg]}")
                continue
            c["исправлено"] += 1
            dg = re.sub(r"\D", "", new)
            if dg in want and new.replace(",", ".") in {v.replace(",", ".") for v in want[dg]}:
                c["  → стало верным"] += 1
                good.append(f"{page} {field}: {txt!r} → {new!r}")
            elif dg in want and any(re.search(r"\d[.,]\d", v) for v in want[dg]):
                c["  → запятая есть, но не там"] += 1
                harm.append(f"{page} {field}: {txt!r} → {new!r}, эталон {want[dg]}")
            elif dg in want:
                c["  → ИСПОРЧЕНО (в эталоне целое)"] += 1
                harm.append(f"{page} {field}: {txt!r} → {new!r}, эталон {want[dg]}")
            else:
                c["  → нет в эталоне, не судим"] += 1

    for k, v in c.items():
        print(f"  {k:34s} {v}")
    for title, lst in (("стало верным", good), ("вред", harm), ("пропущено", missed)):
        if lst:
            print(f"\n{title} ({len(lst)}):")
            for x in lst[:20]:
                print("   " + x)


if __name__ == "__main__":
    main()
