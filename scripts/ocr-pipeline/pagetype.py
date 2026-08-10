#!/usr/bin/env python3
"""Тип страницы журнала: КАРТОЧКА скважины или ТАБЛИЦА описания керна.

Зачем понадобилось. Все цифры конвейера («48 % полей без человека при 95 %») получены
на 15 страницах стенда, а стенд почти весь из страниц-КАРТОЧЕК: паспорт скважины, где
в линовку вписаны координаты, отметка устья, даты, диаметры. Рукописные же страницы
архива в массе — таблицы описания керна: связный текст в графах и несколько глубин в
левой колонке. Числовых чтений там 0,9 на страницу против 4,9 на карточке, и мерить
одно на другом нельзя.

(Заодно этот же классификатор поправил исходную посылку: карточек на стенде 13, а не
15 — `p004_2` и `p024_10` таблицы. В `gt.jsonl` у них с самого начала стоит
`kind: "table"`, поле просто никто не прочитал. Совпадение с человеческой разметкой —
15 из 15, и это единственная независимая проверка точности, которая тут есть.)

Признак дешёвый и не требует нашей модели. Заголовок бланка НАПЕЧАТАН, а печатный
слой у нас уже отделён по цвету (`inklayer.split`, второе значение). Обычный OCR
читает его начисто — на карточке выходит «ЖУРНАЛ ДОКУМЕНТАЦИИ СКВАЖИН КОЛОНКОВОГО
БУРЕНИЯ ... 1. Долина речки, ручья», на таблице описания тот же OCR выдаёт кашу из
обломков вертикальных заголовков граф. Разделение видно даже без ключевых слов, но
на кашу полагаться не будем.

**Форм карточки НЕ ОДНА.** Кроме «ЖУРНАЛ ДОКУМЕНТАЦИИ СКВАЖИН КОЛОНКОВОГО БУРЕНИЯ»
в корпусе есть разворот другого подрядчика — «журнал документации скважин
ударно-канатного и колонкового бурения» с «АКТОМ НА ЗАВЕРШЁННУЮ СКВАЖИНУ» на левой
половине. Поэтому здесь не одна фраза из задания, а набор меток, и каждая метка
взята из НАБЛЮДАЕМОГО вывода tesseract на этих сканах, а не из головы.

Считаем очки за метки обоих типов и сравниваем. Страницы, где очков мало у всех,
честно помечаются `?` — их смотрит человек, а не додумывает скрипт.

  pagetype.py <pdf|jpg> ... [--dpi=150] [--jobs=8] [--tsv=pagetype.tsv]

Стоит копейки: ~1 с на страницу (0,3 с разделение + 0,1..2,6 с OCR), ядра делятся
процессами — по замеру `scale.py` это вдвое быстрее, чем потоками внутри одного.
"""
import glob
import multiprocessing as mp
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image

from inklayer import split

Image.MAX_IMAGE_PIXELS = None

# Метки взяты из вывода tesseract на печатном слое этих же сканов. Вес 2 —
# метка сама по себе решает дело, вес 1 — только в сумме с другими.
CARD = [
    (2, "документации скважин"),        # обе формы карточки
    (2, "колонкового бурения"),
    (2, "акт на завершенную скважину"),
    (1, "тип россыпи"),
    (1, "азимут линии"),
    (1, "азимут буровой линии"),
    (1, "отметка устья скважины"),
    (1, "диаметр коронки"),
    (1, "диаметры башмака"),
    (1, "промывальщик"),
    (1, "маркшейдер"),
    (1, "скважина начата"),
    (1, "скважина закончена"),
    (1, "пройдено в мерзлоте"),
    (1, "результаты подсчета"),
    (1, "характеристика самородков"),
    (1, "тип бурового станка"),
]
TABLE = [
    (2, "геологическое описание пробуренных"),
    (1, "описание разреза"),
    (1, "литологический разрез"),
    (1, "буровой мастер"),
    (1, "характер золота"),
    (1, "мер проходок"),
    (1, "категория породы"),
    (1, "выход керна"),
]
# ЗАПРЕТ. «Промывочный журнал» — отдельный бланк-приложение, и в его подзаголовке
# стоит «обязательное приложение к журналу ДОКУМЕНТАЦИИ СКВАЖИН». На эту строку
# ловится решающая метка карточки: из 83 найденных «карточек» так пролезли
# промывочные журналы. Своё название у бланка крупное и читается начисто во всех
# восьми проверенных случаях, поэтому запрет надёжнее, чем ослабление метки.
# Запрет обязан цепляться за СОБСТВЕННОЕ имя приложения, а не за слово «промывка».
# Первая редакция запрещала «промывочной установки» — и выкосила 11 настоящих
# карточек: у формы-разворота есть поле «наименование бурового станка,
# промывочной установки». Отличается только «ТИП промывочной установки» — это
# шапка приложения.
WASH = [
    (2, "промывочный журнал"),
    (2, "приложение к журналу"),
    (2, "тип промывочной установки"),
    (1, "промываемой породы"),
]


def norm(s):
    return re.sub(r"[^а-яa-z0-9]+", " ", s.lower().replace("ё", "е")).strip()


# tesseract собран с OpenMP и по умолчанию берёт все ядра. При 16 процессах это
# даёт load average 60 и замедляет каждый вызов в тридцать раз: страница, которая
# считается 1 с в одиночку, считалась 2,5 минуты. Тот же урок, что в scale.py, —
# один поток на процесс, процессов по числу ядер.
ONE_THREAD = dict(os.environ, OMP_NUM_THREADS="1", OMP_THREAD_LIMIT="1")


def ocr_printed(im, tmpdir):
    """Печатный слой → текст. Рукопись вычтена цветом, мешать OCR она не будет."""
    _hand, printed, meta = split(im)
    p = os.path.join(tmpdir, "pr.png")
    printed.save(p)
    r = subprocess.run(["tesseract", p, "-", "-l", "rus", "--psm", "6"],
                       capture_output=True, text=True, timeout=600, env=ONE_THREAD)
    return norm(r.stdout), meta


def score(text, marks):
    hits = [m for w, m in marks if m in text]
    return sum(w for w, m in marks if m in text), hits


def classify(text):
    """→ (тип, очки карточки, очки таблицы, сработавшие метки).

    `?` — не приговор «мусор», а честное «признаков не хватило»: такие страницы
    идут человеку. Молча относить их к таблицам значило бы прятать пропущенные
    карточки в статистике.
    """
    c, ch = score(text, CARD)
    t, th = score(text, TABLE)
    w, wh = score(text, WASH)
    marks = ch + ["-" + x for x in th] + ["!" + x for x in wh]
    if w >= 2:
        return "промывка", c, t, marks
    if c >= 2 and c > t:
        kind = "карточка"
    elif t >= 2 and t >= c:
        kind = "таблица"
    else:
        kind = "?"
    return kind, c, t, marks


def one_page(args):
    path, label, max_side = args
    try:
        im = Image.open(path).convert("RGB")
        # Готовые сканы стенда лежат в 300 dpi, страницы PDF мы рендерим в 150.
        # Меркой качества OCR служит кегль в пикселях, поэтому приводим к одному
        # масштабу — иначе метки, настроенные на 150 dpi, поедут.
        if max_side and max(im.size) > max_side:
            k = max_side / max(im.size)
            im = im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS)
        with tempfile.TemporaryDirectory() as tmp:
            text, meta = ocr_printed(im, tmp)
    except Exception as e:
        return dict(page=label, kind="ошибка", card=0, table=0, hits=[str(e)[:60]],
                    colour=False, blue=0.0, chars=0)
    kind, c, t, hits = classify(text)
    return dict(page=label, kind=kind, card=c, table=t, hits=hits,
                colour=meta["colour"], blue=meta["blue_share"], chars=len(text))


def render(pdf, dpi, tmp):
    prefix = os.path.join(tmp, "p")
    subprocess.run(["pdftoppm", "-jpeg", "-r", str(dpi), pdf, prefix],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=7200)
    out = []
    doc = os.path.basename(pdf).rsplit(".", 1)[0].replace("holdout-", "")
    for f in sorted(glob.glob(prefix + "-*.jpg")):
        pg = int(f.rsplit("-", 1)[1].split(".")[0])
        out.append((f, f"h{doc}_{pg}", 0))
    return out


def main():
    dpi, jobs, tsv, max_side = 150, max(1, (os.cpu_count() or 4)), "pagetype.tsv", 1800
    srcs = []
    for a in sys.argv[1:]:
        if a.startswith("--dpi="):
            dpi = int(a.split("=")[1])
        elif a.startswith("--jobs="):
            jobs = int(a.split("=")[1])
        elif a.startswith("--tsv="):
            tsv = a.split("=")[1]
        elif a.startswith("--max-side="):
            max_side = int(a.split("=")[1])
        else:
            srcs.append(a)

    rows, imgs = [], []
    for src in srcs:
        if src.lower().endswith(".pdf"):
            with tempfile.TemporaryDirectory() as tmp:
                items = render(src, dpi, tmp)
                with mp.Pool(jobs) as pool:
                    rows += pool.map(one_page, items)
            print(f"{os.path.basename(src)}: {len(items)} стр", flush=True)
        else:
            imgs.append((src, os.path.basename(src).rsplit(".", 1)[0], max_side))
    if imgs:
        with mp.Pool(jobs) as pool:
            rows += pool.map(one_page, imgs)

    with open(tsv, "w") as f:
        f.write("page\tkind\tcard\ttable\tcolour\tblue\tchars\thits\n")
        for r in rows:
            f.write(f"{r['page']}\t{r['kind']}\t{r['card']}\t{r['table']}\t"
                    f"{int(r['colour'])}\t{r['blue']}\t{r['chars']}\t{','.join(r['hits'])}\n")

    from collections import Counter
    cnt = Counter(r["kind"] for r in rows)
    hand = Counter(r["kind"] for r in rows if r["colour"])
    print(f"\nвсего страниц {len(rows)}: " +
          ", ".join(f"{k} {v}" for k, v in cnt.most_common()))
    print(f"из них рукописных (синие чернила): {sum(hand.values())} — " +
          ", ".join(f"{k} {v}" for k, v in hand.most_common()))
    cards = [r["page"] for r in rows if r["kind"] == "карточка" and r["colour"]]
    print(f"\nРУКОПИСНЫХ КАРТОЧЕК: {len(cards)}")
    print(",".join(cards))
    unk = [r["page"] for r in rows if r["kind"] == "?" and r["colour"]]
    print(f"\nне определилось (смотреть глазами): {len(unk)}")
    print(",".join(unk))
    print(f"\n→ {tsv}")


if __name__ == "__main__":
    main()
