#!/usr/bin/env python3
"""Лист сверки: показать человеку ТОЛЬКО то, что конвейер принял без него.

Ради чего. Чтобы узнать полноту, эталон нужен целиком — надо знать все поля страницы,
это дни разметки. Чтобы узнать ТОЧНОСТЬ ПРИНЯТОГО, достаточно проверить принятое:
несколько сотен чтений, полчаса глазами. Первое мы себе позволить не можем на каждом
новом корпусе, второе — можем на каждом.

Отсюда правило замера на новых данных: полноту не трогаем, точность принятого меряем
всегда. Просевшая точность — сигнал «не выкатывать», и его видно дёшево.

**Показываем СТРОКУ БЛАНКА ЦЕЛИКОМ, а не вырезку.** Первая редакция листа давала голый
островок чернил в сорок пикселей, и проверить его было нельзя даже человеку: «32» —
это глубина, номер линии или обрывок соседнего числа? Непонятно, пока не видно
печатной подписи слева и соседей справа. Поэтому здесь строка формы от её начала до
конца, проверяемое значение обведено красным, рядом — имя поля, подпись как её
прочитал OCR, и вердикт доменного правила. Ровно тот контекст, по которому решение
принимается за секунду, а не за минуту разглядывания.

Две галочки, а не одна: «прочитано неверно» и «поле не то». Это разные ошибки с
разной ценой — первая портит значение, вторая уносит верное значение в чужую графу, —
и лечатся они в разных местах конвейера. Внизу считаются обе.

  review_sheet.py <главная.values.jsonl> <второй.values.jsonl> <out.html>
                  [--no-fields] [--dir=bench/img300] [--gt=gt/gt.jsonl]
"""
import base64
import html
import io
import json
import os
import sys

from PIL import Image, ImageDraw

from values import extract

Image.MAX_IMAGE_PIXELS = None
STRIP_W = 1180          # ширина полосы в HTML; строка A4 в 300 dpi ~2400 px

TPL_HEAD = """<!doctype html><meta charset="utf-8">
<title>Сверка принятого — {n} чтений</title>
<style>
 body{{font:15px/1.5 system-ui,sans-serif;margin:20px;max-width:1450px}}
 h1{{font-size:20px;margin-bottom:4px}} .sub{{color:#555;margin-bottom:16px;max-width:900px}}
 table{{border-collapse:collapse;width:100%}}
 td,th{{border-bottom:1px solid #e6e6e6;padding:8px 8px;text-align:left;vertical-align:top}}
 th{{background:#fafafa;font-weight:600;position:sticky;top:0;z-index:2}}
 img{{display:block;max-width:100%;background:#fff;border:1px solid #eee}}
 .val{{font:17px ui-monospace,monospace;font-weight:700}}
 .fld{{color:#0a6b2a;font-size:13px}} .nofld{{color:#b26a00;font-size:13px}}
 .lab{{color:#777;font-size:12px;font-style:italic}}
 .pg{{color:#999;font-size:12px}}
 .bad{{color:#b00;font-size:12px}}
 tr:has(.w:checked){{background:#fff2f0}}
 tr:has(.f:checked){{background:#fffbe6}}
 tr:has(.w:checked):has(.f:checked){{background:#ffeae6}}
 label{{display:block;white-space:nowrap;font-size:13px;margin-bottom:6px}}
 #bar{{position:sticky;bottom:0;background:#fff;border-top:2px solid #333;padding:10px 0;
      font-size:16px;z-index:3}}
</style>
<h1>Сверка принятого: {n} чтений с {p} страниц</h1>
<div class="sub">Это всё, что конвейер принял БЕЗ человека. На каждой полосе — строка
бланка целиком, проверяемое значение обведено красным. Отметьте
«<b>читано неверно</b>», если в красной рамке написано не то, что в колонке
«прочитано». Отметьте «<b>поле не то</b>», если значение прочитано верно, но приписано
не к той графе. Пустые клетки и нечитаемые росчерки считайте неверными только если
машина выдала на них число. Внизу — итог.</div>
<table><tr><th style="width:{sw}px">строка бланка</th><th style="width:130px">прочитано</th>
<th style="width:210px">поле · подпись</th><th style="width:150px">отметки</th></tr>
"""

TPL_TAIL = """</table>
<div id="bar">строк {n} · читано неверно <b id="w">0</b> · поле не то <b id="f">0</b>
 · <b>точность чтения <span id="a">—</span></b> · точность привязки <span id="b">—</span>
 &nbsp; <button onclick="dump()">Сохранить отметки в файл</button>
 <button onclick="paste_()">Показать текстом</button></div>
<script>
// Отметки живут только в DOM: закрыл вкладку — работа пропала. Поэтому две кнопки,
// а не одна: файл на диск и текст для копирования. Полчаса чужого времени стоят
// дороже десяти строк скрипта.
const W=[...document.querySelectorAll('.w')], F=[...document.querySelectorAll('.f')];
const NF={nf};
function rows(){{
 return [...document.querySelectorAll('tr')].filter(t=>t.querySelector('.w'))
  .map((t,i)=>[i+1, t.querySelector('.pg').textContent.trim(),
               t.querySelector('.val').textContent.trim(),
               t.querySelector('.w').checked?1:0, t.querySelector('.f').checked?1:0]);
}}
function text(){{
 const r=rows(), w=r.filter(x=>x[3]).length, f=r.filter(x=>x[4]).length;
 return `# всего\t${{r.length}}\tневерно\t${{w}}\tполе_не_то\t${{f}}\\n`
      + `# N\tстраница\tпрочитано\tневерно\tполе_не_то\\n`
      + r.filter(x=>x[3]||x[4]).map(x=>x.join('\t')).join('\\n');
}}
function dump(){{
 const b=new Blob([text()],{{type:'text/tab-separated-values'}});
 const a=document.createElement('a');
 a.href=URL.createObjectURL(b); a.download='review_marks.tsv'; a.click();
}}
function paste_(){{
 const a=document.createElement('textarea'); a.value=text();
 a.style.cssText='position:fixed;inset:0;width:100%;height:100%;z-index:9999;font:12px monospace';
 document.body.appendChild(a); a.select();
}}
function upd(){{
 const w=W.filter(r=>r.checked).length, f=F.filter(r=>r.checked).length;
 w_.textContent=w; f_.textContent=f;
 a.textContent=((W.length-w)/W.length*100).toFixed(1)+' %';
 const named=W.length-NF;
 b.textContent=named?((named-f)/named*100).toFixed(1)+' % (из '+named+' названных)':'—';
}}
const w_=document.getElementById('w'),f_=document.getElementById('f'),
      a=document.getElementById('a'),b=document.getElementById('b');
W.concat(F).forEach(r=>r.addEventListener('change',upd));upd();
</script>
"""


def b64(im, fmt="JPEG", **kw):
    buf = io.BytesIO()
    im.save(buf, format=fmt, **kw)
    return base64.b64encode(buf.getvalue()).decode()


def load(path):
    out = {}
    for line in open(path):
        if line.strip():
            o = json.loads(line)
            out[(o["page"], tuple(o["box"]))] = o
    return out


def strip(page_im, line, box, pad=14):
    """Полоса страницы со строкой бланка; проверяемое значение обведено красным."""
    W, H = page_im.size
    lx0, ly0, lx1, ly1 = line
    x0, y0 = max(0, lx0 - pad), max(0, ly0 - pad)
    x1, y1 = min(W, lx1 + pad), min(H, ly1 + pad)
    im = page_im.crop((x0, y0, x1, y1)).convert("RGB")
    d = ImageDraw.Draw(im)
    d.rectangle([box[0] - x0 - 3, box[1] - y0 - 3, box[2] - x0 + 3, box[3] - y0 + 3],
                outline=(220, 0, 0), width=4)
    if im.width > STRIP_W:
        k = STRIP_W / im.width
        im = im.resize((STRIP_W, max(1, int(im.height * k))), Image.LANCZOS)
    return im


def main():
    a_path, b_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    with_fields = "--no-fields" not in sys.argv
    need_digit = "--digit" in sys.argv
    need_name = "--named" in sys.argv
    do_postfix = "--postfix" in sys.argv
    d, gt_path = "bench/img300", None
    for a in sys.argv[4:]:
        if a.startswith("--dir="):
            d = a.split("=")[1]
        elif a.startswith("--gt="):
            gt_path = a.split("=")[1]

    A, B = load(a_path), load(b_path)
    accepted = []
    for k in A:
        if k not in B:
            continue
        ta, tb = A[k]["text"].strip(), B[k]["text"].strip()
        if ta and ta == tb:
            accepted.append((k, ta))
    accepted.sort(key=lambda x: (x[0][0], x[0][1][1], x[0][1][0]))

    sets = None
    if gt_path:
        from verify import observed_sets
        sets = observed_sets([json.loads(l) for l in open(gt_path) if l.strip()])

    rows, named = [], 0
    for pg in sorted({k[0] for k, _ in accepted}):
        path = f"{d}/{pg}.jpg"
        page_im = Image.open(path)
        vals, _ = extract(path)
        info = {}
        if with_fields:
            from fieldmap import attach
            for r in attach(path, [dict(box=v["box"], px=v["px"]) for v in vals]):
                info[r["box"]] = r
        crops = {tuple(v["box"]): v["crop"] for v in vals} if do_postfix else {}
        for (p2, box), txt in accepted:
            if p2 != pg:
                continue
            r = info.get(box, {})
            f = r.get("field")
            # Отсев не-значений. 40 % принятого — это «-», «по», «с»: обрывки линовки
            # и росчерков подписи, попавшие в слой рукописи. Они не значения ни в
            # каком смысле, и держать их в приёмке значит мерить точность на мусоре.
            if need_digit and not any(ch.isdigit() for ch in txt):
                continue
            if need_name and not f:
                continue
            if do_postfix and f:
                from postfix import decimal_fields, fix_confuse, fix_sep, fix_unit, numeric_fields
                nf, df = numeric_fields(), decimal_fields()
                for fn in (lambda t: fix_unit(t, f, nf),
                           lambda t: fix_confuse(t, f, nf),
                           lambda t: fix_sep(t, f, df, crops.get(box))):
                    new, why = fn(txt)
                    if why:
                        txt = new
            line = r.get("line") or box
            im = strip(page_im, line, box)
            named += bool(f)
            fld = (f'<span class="fld"><b>{html.escape(f)}</b></span>' if f
                   else '<span class="nofld">поле не определено</span>')
            bad = ""
            if f and sets is not None:
                from verify import check_field
                v, why = check_field(f, txt, sets)
                if v != "ok":
                    bad = f'<div class="bad">правило: {html.escape(v)} — {html.escape(why)}</div>'
            lab = html.escape(r.get("label", ""))[:70]
            rows.append(
                f'<tr><td><img src="data:image/jpeg;base64,{b64(im, quality=72)}"></td>'
                f'<td class="val">{html.escape(txt)}</td>'
                f'<td>{fld}<div class="lab">…{lab}</div>{bad}'
                f'<div class="pg">{pg}</div></td>'
                f'<td><label><input type="checkbox" class="w"> читано неверно</label>'
                f'<label><input type="checkbox" class="f"> поле не то</label></td></tr>')

    pages = len({k[0] for k, _ in accepted})
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    with open(dst, "w") as fh:
        fh.write(TPL_HEAD.format(n=len(accepted), p=pages, sw=STRIP_W))
        fh.write("\n".join(rows))
        fh.write(TPL_TAIL.format(n=len(accepted), nf=len(accepted) - named))
    print(f"принято чтений: {len(accepted)} с {pages} страниц → {dst}")
    print(f"в среднем {len(accepted)/max(1,pages):.1f} принятых чтений на страницу")
    if with_fields:
        print(f"с именем поля: {named} ({named/max(1,len(accepted)):.0%})")
    print(f"размер файла: {os.path.getsize(dst)/1e6:.1f} МБ")


if __name__ == "__main__":
    main()
