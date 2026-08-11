#!/usr/bin/env python3
"""
Нарезка ЧУЖИХ ЖАНРОВ (other / disc / court) под регресс якоря уровня документа.

Зачем. Приёмка якоря 09.08 снята на публичном пуле ЕИС/Роснедра, и обе его половины
теперь потрачены: правило выводилось из классов ошибок половины A, а на половине B я
один раз, до правки кода, прикинул его эффект по уже осуждённым находкам. Нужен корпус,
которого правило не видело ВООБЩЕ. Разметка для этого не нужна: точность считается
независимым судьёй по находкам, детектор по корпусу гоняется бесплатно.

Геометрия — копия chunk-public-pool.ts: документ берётся ЦЕЛИКОМ или не берётся вовсе,
выборки кусков ВНУТРИ документа нет (это ещё одна ручка подкрутки, её быть не должно).
chunk_id несёт doc_id НЕТРОНУТЫМ — усечение до 24 знаков уже дало реальную коллизию
двух разных документов rosnedra на пилоте 06.08.

Выборка документов — детерминированная (свой LCG, seed в имени файла), НЕ случайная:
прогон обязан воспроизводиться. Порядок берётся от отсортированного doc_id, поэтому не
зависит от порядка строк в .jsonl.

ВАЖНО про то, что этот файл делает и чего не делает. precision.ts --phase sample читает
отсюда ТОЛЬКО множество (corpus, doc_id), а текст берёт из .corpus/<corpus>.jsonl и
отдаёт детектору документ ЦЕЛИКОМ. То есть якорь уровня документа проверяется на полном
тексте документа, ровно как в приёмке на публичном пуле, а не на куске в 3000 знаков.
Поле text здесь — для совместимости формата и для харнессов полноты, не для точности.

  python3 scripts/geo-coord/chunk-genres.py --n 700 --out .work/geo-coord/chunks-genres.jsonl
"""
import argparse
import json
import os

CHUNK = 3000
MIN = 400


def lcg(seed: int):
    s = seed & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
        return s / 4294967296

    return nxt


def shuffled(items, seed: int):
    out = list(items)
    rnd = lcg(seed)
    for i in range(len(out) - 1, 0, -1):
        j = int(rnd() * (i + 1))
        out[i], out[j] = out[j], out[i]
    return out


def cut(text: str, size: int):
    out = []
    i = 0
    while i < len(text):
        end = min(i + size, len(text))
        if end < len(text):
            nl = text.rfind("\n", i, end)
            if nl > i + size // 2:
                end = nl
        out.append((i, text[i:end]))
        i = end
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=700, help="документов на жанр")
    ap.add_argument("--seed", type=int, default=20260809)
    ap.add_argument("--corpora", default="other,disc,court")
    ap.add_argument("--max-chars", type=int, default=200_000,
                    help="документы длиннее пропускаются: один документ на 1,4 млн знаков "
                         "доминировал бы и выборкой, и временем прогона")
    ap.add_argument("--out", default=".work/geo-coord/chunks-genres.jsonl")
    a = ap.parse_args()

    rows = []
    summary = {}
    for corpus in a.corpora.split(","):
        docs = []
        with open(f".corpus/{corpus}.jsonl", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                docs.append((r["doc_id"], r["text"]))
        total = len(docs)
        docs = [d for d in docs if len(d[1]) <= a.max_chars]
        skipped_long = total - len(docs)
        docs.sort(key=lambda d: d[0])
        pick = shuffled(docs, a.seed)[: a.n]
        pick.sort(key=lambda d: d[0])

        s = {"всего": total, "длинных пропущено": skipped_long, "взято": len(pick),
             "кусков": 0, "знаков": 0}
        for doc_id, text in pick:
            s["знаков"] += len(text)
            for off, piece in cut(text, CHUNK):
                if len(piece.strip()) < MIN:
                    continue
                s["кусков"] += 1
                rows.append({
                    "chunk_id": f"{corpus}:{doc_id}:{off}",
                    "corpus": corpus,
                    "doc_id": doc_id,
                    "offset": off,
                    "tier": "A",
                    "text": piece,
                })
        summary[corpus] = s

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"ИТОГО кусков: {len(rows)} → {a.out}")


if __name__ == "__main__":
    main()
