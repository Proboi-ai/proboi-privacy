#!/usr/bin/env python3
"""Доменный верификатор полей бурового журнала — слой, которому модель не нужна.

Идея. Распознаватель всегда что-то печатает и не умеет сказать «не знаю». Значит
право сказать «не знаю» ему надо дать снаружи. Здесь — два самых дешёвых способа:

  1. ГРАММАТИКА ПОЛЯ. Мы знаем бланк. «координата X» — семь цифр, запятая, три цифры;
     «азимут» — целое 0..360; «начата» — дата. Значение не той формы прочитано неверно
     независимо от того, насколько модель в нём уверена.

  2. СВЯЗИ МЕЖДУ ПОЛЯМИ. Поля не независимы: внутренний диаметр меньше наружного,
     мерзлота «от» меньше «до», скважину не закончили раньше, чем начали. Противоречие
     ловит ошибку, которую по одному полю увидеть нельзя.

Принцип, которому подчинён весь файл: **множества допустимых значений берём из
эталона, а не из головы.** Отраслевые ряды диаметров я по памяти не знаю и выдумывать
не буду — набор собирается из корпуса функцией observed_sets(). Verdict «редкое
значение» и verdict «неверный формат» намеренно разные: первое — повод показать
человеку, второе — повод не показывать вовсе.
"""
import json
import re
from collections import defaultdict

# ── грамматика полей ────────────────────────────────────────────────────────────
DEC = r"\d+(?:[.,]\d+)?"
SPECS = {
    "координата X":                   dict(re=r"\d{7}[.,]\d{1,3}", lo=5_000_000, hi=9_000_000),
    "координата Y":                   dict(re=r"\d{6}[.,]\d{1,3}", lo=100_000, hi=999_999),
    "широта N":                       dict(re=r"\d{1,2}°\d{1,2}[.,]\d{1,3}"),
    "долгота E":                      dict(re=r"\d{1,3}°\d{1,2}[.,]\d{1,3}"),
    "начата":                         dict(kind="date"),
    "окончена":                       dict(kind="date"),
    "закончена":                      dict(kind="date"),
    "дата":                           dict(kind="date"),
    "азимут буровой линии":           dict(re=r"\d{1,3}", lo=0, hi=360),
    "азимут линии":                   dict(re=r"\d{1,3}", lo=0, hi=360),
    "выход керна, %":                 dict(re=DEC, lo=0, hi=100),
    "доля галечника, %":              dict(re=r"\d{1,3}(?:-\d{1,3})?", lo=0, hi=100),
    "доля гравийно-песчаного, %":     dict(re=r"\d{1,3}(?:-\d{1,3})?", lo=0, hi=100),
    "глинистый, до %":                dict(re=DEC, lo=0, hi=100),
    "льдистость отложений, %":        dict(re=DEC, lo=0, hi=100),
    "год операции":                   dict(re=r"(?:19|20)\d{2}", lo=1900, hi=2100),
    "глубина скважины, м":            dict(re=DEC, lo=0, hi=2000),
    "общая глубина, м":               dict(re=DEC, lo=0, hi=2000),
    "акт: на глубине, м":             dict(re=DEC, lo=0, hi=2000),
    "скважина закрыта на глубине, м": dict(re=DEC, lo=0, hi=2000),
    "пройдено по коренным, м":        dict(re=DEC, lo=0, hi=2000),
    "мерзлота от, м":                 dict(re=DEC, lo=0, hi=2000),
    "мерзлота до, м":                 dict(re=DEC, lo=0, hi=2000),
    "отметка устья, м":               dict(re=DEC, lo=-500, hi=9000),
    "от устья, м":                    dict(re=DEC, lo=0, hi=100_000),
    "на расстоянии, м":               dict(re=DEC, lo=0, hi=100_000),
    "вверх, м":                       dict(re=DEC, lo=0, hi=100_000),
    "вниз, м":                        dict(re=DEC, lo=0, hi=100_000),
    "влево, м":                       dict(re=DEC, lo=0, hi=100_000),
    "вправо, м":                      dict(re=DEC, lo=0, hi=100_000),
    "терраса":                        dict(re=r"\d{1,2}", lo=0, hi=20),
    # номера — допускаем и «С-(-6)»: в журналах встречается такая запись
    "линия №":                        dict(re=r"[А-ЯA-Zа-я]?-?\(?-?\d{1,4}\)?"),
    "скважина №":                     dict(re=r"[А-ЯA-Zа-я]?-?\(?-?\d{1,4}\)?"),
    "от линии №":                     dict(re=r"[А-ЯA-Zа-я]?-?\(?-?\d{1,4}\)?"),
    "от скважины №":                  dict(re=r"[А-ЯA-Zа-я]?-?\(?-?\d{1,4}\)?"),
    "скважины той же линии №":        dict(re=r"[А-ЯA-Zа-я]?-?\(?-?\d{1,4}\)?"),
    "акт: скважина №":                dict(re=r"[А-ЯA-Zа-я]?-?\(?-?\d{1,4}\)?"),
}
# поля-диаметры: ряд допустимых значений НЕ выдумываем, берём из корпуса
DIAM_FIELDS = ["диаметр башмака наружный, мм", "диаметр башмака внутренний, мм",
               "диаметр скважины начальный, мм", "коронка наружный, мм",
               "коронка внутренний, мм", "обсадная труба, мм", "диаметр керна, мм"]

DATE_RE = re.compile(r"^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$")


def num(v):
    m = re.search(r"-?\d+(?:[.,]\d+)?", str(v).replace(" ", ""))
    return float(m.group().replace(",", ".")) if m else None


def parse_date(v):
    m = DATE_RE.match(str(v).strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    y += 2000 if y < 100 and y < 70 else (1900 if y < 100 else 0)
    if not (1 <= d <= 31 and 1 <= mo <= 12 and 1900 <= y <= 2100):
        return None
    return (y, mo, d)


def observed_sets(gt_rows):
    """Ряды допустимых значений — ИЗ КОРПУСА. Ничего не берём по памяти об отрасли."""
    s = defaultdict(set)
    for r in gt_rows:
        for f in r.get("key", []):
            if f["f"] in DIAM_FIELDS:
                n = num(f["v"])
                if n:
                    s["diam"].add(n)
    return s


def check_field(name, value, sets=None):
    """(вердикт, пояснение). Вердикты: ok · формат · диапазон · редкое."""
    v = str(value).strip()
    spec = SPECS.get(name)
    if name in DIAM_FIELDS:
        n = num(v)
        if n is None:
            return "формат", "не число"
        if not (20 <= n <= 1000):
            return "диапазон", f"{n:g} мм вне 20..1000"
        if sets and sets.get("diam") and n not in sets["diam"]:
            near = min(sets["diam"], key=lambda x: abs(x - n))
            return "редкое", f"{n:g} мм нет в ряду корпуса, ближайшее {near:g}"
        return "ok", ""
    if not spec:
        return "ok", ""
    if spec.get("kind") == "date":
        return ("ok", "") if parse_date(v) else ("формат", "не дата ДД.ММ.ГГГГ")
    if "re" in spec and not re.fullmatch(spec["re"], v.replace(" ", "")):
        return "формат", f"не подходит под {spec['re']}"
    if "lo" in spec:
        n = num(v)
        if n is None:
            return "формат", "не число"
        if not (spec["lo"] <= n <= spec["hi"]):
            return "диапазон", f"{n:g} вне {spec['lo']:g}..{spec['hi']:g}"
    return "ok", ""


# ── связи между полями ──────────────────────────────────────────────────────────
def check_document(fields):
    """fields: {имя: значение}. Возвращает список нарушенных связей."""
    bad = []

    def n(k):
        return num(fields[k]) if k in fields else None

    def pair_le(a, b, msg):
        x, y = n(a), n(b)
        if x is not None and y is not None and x > y:
            bad.append(f"{msg}: {a}={x:g} > {b}={y:g}")

    pair_le("мерзлота от, м", "мерзлота до, м", "мерзлота вверх ногами")
    pair_le("мерзлота до, м", "глубина скважины, м", "мерзлота глубже забоя")
    pair_le("пройдено по коренным, м", "общая глубина, м", "коренные глубже общей")
    pair_le("диаметр башмака внутренний, мм", "диаметр башмака наружный, мм",
            "башмак: внутренний больше наружного")
    pair_le("коронка внутренний, мм", "коронка наружный, мм",
            "коронка: внутренний больше наружного")
    pair_le("диаметр керна, мм", "коронка внутренний, мм", "керн толще коронки")

    for a, b in (("начата", "окончена"), ("начата", "закончена")):
        da, db = parse_date(fields.get(a, "")), parse_date(fields.get(b, ""))
        if da and db and da > db:
            bad.append(f"скважина окончена раньше начала: {a}={fields[a]} > {b}={fields[b]}")
    y = n("год операции")
    for k in ("начата", "окончена"):
        d = parse_date(fields.get(k, ""))
        if y and d and d[0] != int(y):
            bad.append(f"год операции {int(y)} не совпадает с датой {k}={fields[k]}")
    return bad


def main():
    import sys
    rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "gt/gt.jsonl")]
    sets = observed_sets(rows)
    print(f"ряд диаметров из корпуса: {sorted(int(x) for x in sets['diam'])}\n")

    # 1. ЛОЖНЫЕ СРАБАТЫВАНИЯ: эталон обязан проходить проверки целиком
    tot = Counter = 0
    bad = []
    for r in rows:
        for f in r.get("key", []):
            tot += 1
            verdict, why = check_field(f["f"], f["v"], sets)
            if verdict != "ok":
                bad.append((r["page"], f["f"], f["v"], verdict, why))
    print(f"ПРОВЕРКА НА ЭТАЛОНЕ (ложные срабатывания): {len(bad)} из {tot} полей отвергнуто")
    for p, f, v, verdict, why in bad:
        print(f"   {verdict:9} {p} {f} = {v!r}  — {why}")

    viol = 0
    for r in rows:
        d = {f["f"]: f["v"] for f in r.get("key", [])}
        for m in check_document(d):
            print(f"   связь    {r['page']}: {m}")
            viol += 1
    print(f"нарушенных связей на эталоне: {viol}")


if __name__ == "__main__":
    main()
