#!/usr/bin/env python3
"""Разделение бланка на печатный слой и рукописный по цвету чернил.

Зачем. Прошлый конвейер первой строкой делал convert("L") и терял цвет. А в этих
журналах бланк напечатан чёрным, линовка чёрная, а заполнено всё синей ручкой.
Отделив синее, мы отдаём распознавателю только рукопись на чистом белом — без
линовки и без печатных подписей, на которых модель как раз и срывается в заученные
фразы («въ томъ, что онъ, какъ человекъ,»).

Порог взят не с потолка: по гистограмме (B−R) на чернилах видно две моды —
печать около 0..+5 и рукопись +15..+75, впадина на +10..+15. Берём гистерезис:
уверенные ядра штриха (>=25) отращиваем по слабому порогу (>=8), чтобы не съесть
сглаженные края.

Пишущие карандашом страницы синего слоя не дадут — для них честный откат в серое,
о чём функция и сообщает флагом.
"""
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

STRONG, WEAK, INK_L = 25, 8, 180


def _grow(seed, allowed, iters=25):
    """Морфологическое наращивание seed внутри allowed — без scipy, сдвигами numpy."""
    cur = seed.copy()
    for _ in range(iters):
        g = cur.copy()
        g[1:, :] |= cur[:-1, :]
        g[:-1, :] |= cur[1:, :]
        g[:, 1:] |= cur[:, :-1]
        g[:, :-1] |= cur[:, 1:]
        g &= allowed
        if g.sum() == cur.sum():
            break
        cur = g
    return cur


def split(path_or_im, min_share=0.02):
    """→ (hand, printed, meta). hand/printed — картинки L: чернила чёрным на белом.

    min_share: если синего меньше этой доли чернил, считаем, что страница не
    заполнена синей ручкой (карандаш/копия) и честно отдаём серый слой целиком.
    """
    im = Image.open(path_or_im) if isinstance(path_or_im, str) else path_or_im
    im = im.convert("RGB")
    a = np.asarray(im).astype(np.int16)
    R, B = a[..., 0], a[..., 2]
    L = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    ink = L < INK_L
    diff = B - R
    strong = ink & (diff >= STRONG)
    weak = ink & (diff >= WEAK)
    share = strong.sum() / max(1, ink.sum())
    if share < min_share:
        gray = np.where(ink, 0, 255).astype(np.uint8)
        return (Image.fromarray(gray), Image.fromarray(gray),
                dict(colour=False, blue_share=round(float(share), 4)))
    hand_mask = _grow(strong, weak)
    printed_mask = ink & ~hand_mask
    hand = np.where(hand_mask, 0, 255).astype(np.uint8)
    printed = np.where(printed_mask, 0, 255).astype(np.uint8)
    return (Image.fromarray(hand), Image.fromarray(printed),
            dict(colour=True, blue_share=round(float(hand_mask.sum() / max(1, ink.sum())), 4)))


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        name = p.split("/")[-1].rsplit(".", 1)[0]
        h, pr, meta = split(p)
        h.save(f"/tmp/{name}.hand.png")
        pr.save(f"/tmp/{name}.print.png")
        print(f"{name}: цвет={meta['colour']} доля рукописи в чернилах={meta['blue_share']:.1%}")
