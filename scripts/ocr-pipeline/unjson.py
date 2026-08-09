#!/usr/bin/env python3
"""Из вывода Rukopys достаём ТОЛЬКО транскрипции.

Модель отдаёт JSON с областями, где рядом с текстом лежат координаты рамок вида
(50,36),(271,56). Если скормить это метрике целиком, каждая рамка засчитается как
выдуманное число — на одной странице так набежало 109 «выдумок» на пустом месте.
Разбор терпит обрыв: при упоре в лимит токенов JSON не закрывается, и json.loads падает.

  unjson.py <in.jsonl> <out.jsonl>
"""
import json
import re
import sys

TEXT = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"')


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with open(dst, "w") as o:
        for line in open(src):
            if not line.strip():
                continue
            d = json.loads(line)
            raw = d["text"]
            parts = [json.loads('"' + m + '"') for m in TEXT.findall(raw)]
            if parts:
                d["text"] = " ".join(p for p in parts if p)
                d["regions"] = len(parts)
            else:
                # модель ответила не JSON, а простым текстом — берём как есть
                d["text"] = raw
                d["regions"] = -1
            o.write(json.dumps(d, ensure_ascii=False) + "\n")
    print(f"{src} → {dst}: вытащены только транскрипции")


main()
