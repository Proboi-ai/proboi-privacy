#!/usr/bin/env python3
"""Лист сверки: показать человеку ТОЛЬКО то, что конвейер принял без него.

Ради чего. Чтобы узнать полноту, эталон нужен целиком — надо знать все поля страницы,
это дни разметки. Чтобы узнать ТОЧНОСТЬ ПРИНЯТОГО, достаточно проверить принятое:
несколько десятков чтений, полчаса глазами. Первое мы себе позволить не можем на
каждом новом корпусе, второе — можем на каждом.

Отсюда правило замера на новых данных: полноту не трогаем, точность принятого меряем
всегда. Просевшая точность — сигнал «не выкатывать», и его видно дёшево.

На выходе один HTML: вырезка, что прочитала машина, и галочка «неверно». Файл кладётся
в out/ — он содержит куски документов клиента и в публичный репозиторий не поедет.

Колонка «поле» приходит из `fieldmap.py`. Она нужна не для красоты: без имени поля
человек сверяет голые числа и не видит бессмыслицы вроде «азимут = 1164,8». С именем
та же проверка ловит и ошибку чтения, и ошибку привязки — за те же полчаса.

  review_sheet.py <главная.values.jsonl> <второй.values.jsonl> <out.html> [--no-fields]
"""
import base64
import html
import io
import json
import os
import sys

from PIL import Image

from values import extract

TPL_HEAD = """<!doctype html><meta charset="utf-8">
<title>Сверка принятого — {n} чтений</title>
<style>
 body{{font:15px/1.5 system-ui,sans-serif;margin:24px;max-width:1100px}}
 h1{{font-size:20px}} .sub{{color:#555;margin-bottom:18px}}
 table{{border-collapse:collapse;width:100%}}
 td,th{{border-bottom:1px solid #e3e3e3;padding:7px 9px;text-align:left;vertical-align:middle}}
 th{{background:#fafafa;font-weight:600;position:sticky;top:0}}
 img{{max-height:52px;image-rendering:crisp-edges;background:#fff}}
 .val{{font:16px ui-monospace,monospace;font-weight:600}}
 .pg{{color:#777;font-size:13px}}
 tr:has(input:checked){{background:#fff1f0}}
 #bar{{position:sticky;bottom:0;background:#fff;border-top:2px solid #333;padding:12px 0;font-size:16px}}
</style>
<h1>Сверка принятого: {n} чтений с {p} страниц</h1>
<div class="sub">Это всё, что конвейер принял БЕЗ человека. Отметьте те, где машина
прочитала неверно. Пустые и нечитаемые глазом вырезки считайте неверными только если
машина выдала на них число. Внизу — итоговая точность.</div>
<table><tr><th style="width:130px">вырезка</th><th style="width:150px">прочитано</th>
<th style="width:230px">поле</th><th style="width:110px">страница</th><th>неверно</th></tr>
"""

TPL_TAIL = """</table>
<div id="bar">проверено <b id="d">0</b> из {n} · неверных <b id="w">0</b> ·
точность принятого <b id="a">—</b></div>
<script>
const rows=[...document.querySelectorAll('input')];
function upd(){{const w=rows.filter(r=>r.checked).length;
 document.getElementById('w').textContent=w;
 document.getElementById('d').textContent=rows.length;
 document.getElementById('a').textContent=((rows.length-w)/rows.length*100).toFixed(1)+' %';}}
rows.forEach(r=>r.addEventListener('change',upd));upd();
</script>
"""


def b64(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def load(path):
    out = {}
    for line in open(path):
        if line.strip():
            o = json.loads(line)
            out[(o["page"], tuple(o["box"]))] = o
    return out


def main():
    a_path, b_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    with_fields = "--no-fields" not in sys.argv
    A, B = load(a_path), load(b_path)
    accepted = []
    for k in A:
        if k not in B:
            continue
        ta, tb = A[k]["text"].strip(), B[k]["text"].strip()
        if ta and ta == tb:
            accepted.append((k, ta))
    accepted.sort(key=lambda x: (x[0][0], x[0][1][1], x[0][1][0]))

    # вырезки берём тем же extract, что и распознавание, — иначе покажем не то,
    # что читала модель
    crops, fields = {}, {}
    for pg in sorted({k[0] for k, _ in accepted}):
        path = f"bench/img300/{pg}.jpg"
        vals, _ = extract(path)
        for v in vals:
            crops[(pg, tuple(v["box"]))] = v["crop"]
        if with_fields:
            from fieldmap import attach
            for r in attach(path, [dict(box=v["box"], px=v["px"]) for v in vals]):
                fields[(pg, r["box"])] = r["field"]

    pages = len({k[0] for k, _ in accepted})
    rows = []
    named = 0
    for (pg, box), txt in accepted:
        im = crops.get((pg, box))
        img = (f'<img src="data:image/png;base64,{b64(im)}">' if im
               else '<span class="pg">вырезка не найдена</span>')
        f = fields.get((pg, box))
        named += bool(f)
        rows.append(f'<tr><td>{img}</td><td class="val">{html.escape(txt)}</td>'
                    f'<td>{html.escape(f) if f else "<span class=pg>—</span>"}</td>'
                    f'<td class="pg">{pg}</td><td><input type="checkbox"></td></tr>')

    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    with open(dst, "w") as f:
        f.write(TPL_HEAD.format(n=len(accepted), p=pages))
        f.write("\n".join(rows))
        f.write(TPL_TAIL.format(n=len(accepted)))
    print(f"принято чтений: {len(accepted)} с {pages} страниц → {dst}")
    print(f"в среднем {len(accepted)/max(1,pages):.1f} принятых чтений на страницу")
    if with_fields:
        print(f"с именем поля: {named} ({named/max(1,len(accepted)):.0%})")


if __name__ == "__main__":
    main()
