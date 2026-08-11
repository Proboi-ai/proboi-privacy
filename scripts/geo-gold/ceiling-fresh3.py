#!/usr/bin/env python3
"""Потолок связки «правила + модель» на приёмочном корпусе fresh3.

Зачем. Решение «модель не нужна ни в одном типе» (09.08) снято на `real-eval` — ПОТРАЧЕННОМ
корпусе, где правила показывали GEO_NAME 68,4 %. На чистом `fresh3` правила дают 51,7 %, то
есть вычитание, из которого получилось «+3,5 пункта», считалось от неподтвердившейся цифры.
Этот счётчик пересчитывает ту же таблицу на приёмочном материале.

Считается ОФЛАЙН из уже снятых выгрузок, модель второй раз не гоняется:
  * что нашли правила      — `.work/geo-gold/FRESH3.json` (поле «нашёл»)
  * что правила пропустили  — `.work/geo-gold/FRESH3-misses.json` (значение + chunk_id)
  * что нашла модель        — выгрузка `predict_dump.py` (спаны со счётами по chunk_id)

Потолок = доля эталона, покрытая ОБЪЕДИНЕНИЕМ правил и модели, при ИДЕАЛЬНОМ фильтре
(все ложные находки модели убраны бесплатно). Это верхняя граница любого проверяльщика:
реальный фильтр всегда хуже. Развёртка по порогу — тем же приёмом, что в predict_dump:
спаны сняты при низком пороге, порог крутится офлайн.

    python scripts/geo-gold/ceiling-fresh3.py \\
        --score .work/geo-gold/FRESH3.json \\
        --misses .work/geo-gold/FRESH3-misses.json \\
        --dump .work/geo-gold/model-fresh3-prod8.jsonl \\
        --thresholds 0.3,0.5,0.7
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

GEO_TYPES = ("GEO_NAME", "WELL", "COORD", "LICENSE_SUBSOIL")


def norm(s: str) -> str:
    """Сравнение значений — как в score.ts: без регистра и краевых пробелов."""
    return " ".join(s.split()).strip().lower()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--score", required=True)
    ap.add_argument("--misses", required=True)
    ap.add_argument("--dump", required=True)
    ap.add_argument("--thresholds", default="0.3,0.5,0.7")
    ap.add_argument("--out")
    args = ap.parse_args()

    score = json.loads(Path(args.score).read_text(encoding="utf-8"))["всего"]
    misses = json.loads(Path(args.misses).read_text(encoding="utf-8"))

    # выгрузка модели: chunk_id -> [(тип, текст спана, счёт)]
    by_chunk: dict[str, list[tuple[str, str, float]]] = defaultdict(list)
    for line in Path(args.dump).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        text = row["text"]
        for s in row["model"]:
            by_chunk[row["doc_id"]].append((s["type"], norm(text[s["start"]:s["end"]]), float(s["score"])))

    miss_by_type: dict[str, list[dict]] = defaultdict(list)
    for m in misses:
        miss_by_type[m["type"]].append(m)

    report = {"пороги": {}}
    print(f"{'тип':16} {'эталон':>7} {'правила':>9} {'порог':>6} {'модель добирает':>16} {'потолок связки':>15}")
    for t in args.thresholds.split(","):
        thr = float(t)
        rows = {}
        for kind in GEO_TYPES:
            if kind not in score:
                continue
            gold = score[kind]["эталон"]
            found = score[kind]["нашёл"]
            ms = miss_by_type.get(kind, [])
            # модель «добирает» промах, если в ТОМ ЖЕ куске у неё есть спан того же типа,
            # чей текст совпал со значением промаха (или содержит его целиком).
            recovered = 0
            for m in ms:
                val = norm(m["value"])
                if not val:
                    continue
                for (st, span_text, sc) in by_chunk.get(m["chunk_id"], ()):
                    if st != kind or sc < thr:
                        continue
                    if span_text == val or val in span_text or span_text in val:
                        recovered += 1
                        break
            ceil = (found + recovered) / gold * 100 if gold else None
            base = found / gold * 100 if gold else None
            rows[kind] = {"эталон": gold, "правила": round(base, 1) if base is not None else None,
                          "добралаМодель": recovered,
                          "потолокСвязки": round(ceil, 1) if ceil is not None else None,
                          "приростПунктов": round(ceil - base, 1) if ceil is not None else None}
            print(f"{kind:16} {gold:7} {base:8.1f}% {thr:6.2f} {recovered:16} {ceil:14.1f}%")
        report["пороги"][t] = rows

    if args.out:
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n→ {args.out}")


if __name__ == "__main__":
    main()
