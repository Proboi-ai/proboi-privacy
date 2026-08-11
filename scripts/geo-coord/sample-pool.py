#!/usr/bin/env python3
"""
Четвёртый корпус координат: расслоённая выборка из публичного пула ЕИС.

Зачем расслоение. Координаты в закупочных документах редки: слово-маркер («координат»,
«угловых точек», «СК-42», «X=») встречается в 3,6 % документов, градусная запись — в 7,0 %.
Простая случайная выборка на 150 документов дала бы полтора десятка носителей координат —
интервал по полноте вышел бы шире самого эффекта. Поэтому два слоя с ИЗВЕСТНЫМИ весами:

  K — документы, где координаты правдоподобны (берутся ВСЕ, вес 1);
  O — все прочие (случайная доля, вес = |O| / n_O).

Оценка по всему пулу считается взвешенно, поэтому расслоение НЕ подменяет корпус:
класс «голая метровая пара без подписи» живёт в слое O и входит в общую цифру со своим весом.

Критерий отбора в K — СЛОВА-МАРКЕРЫ и градусная запись, а не наши правила: он не спрашивает
детектор и не знает ни одного его шаблона для метровых пар. Иначе замер станет циркулярным.

  python3 scripts/geo-coord/sample-pool.py \
      --pool .work/geo-gold/chunks-public-pool.jsonl \
      --exclude .work/geo-gold/chunks.jsonl \
      --n-other 150 --out-dir .work/geo-coord
"""
import argparse
import collections
import json
import random
import re

KW = re.compile(r"координат|угловы[хе]\s+точ|СК-42|МСК-|широт|долгот|X\s*=|Y\s*=|с\.ш\.|в\.д\.", re.I)
NUM6 = re.compile(r"(?<![\d.,])\d{6,8}(?:[.,]\d+)?(?![\d])")
DEG = re.compile(r"\d{1,3}\s*[°ᵒо]\s*\d{1,2}")

ap = argparse.ArgumentParser()
ap.add_argument("--pool", default=".work/geo-gold/chunks-public-pool.jsonl")
ap.add_argument("--exclude", nargs="*", default=[], help="файлы кусков, чьи doc_id уже использованы")
ap.add_argument("--n-other", type=int, default=150)
ap.add_argument("--seed", type=int, default=20260809)
ap.add_argument("--out-dir", default=".work/geo-coord")
a = ap.parse_args()

seen = set()
for p in a.exclude:
    for line in open(p, encoding="utf8"):
        line = line.strip()
        if line:
            seen.add(json.loads(line)["doc_id"])

chunks = collections.defaultdict(list)
for line in open(a.pool, encoding="utf8"):
    line = line.strip()
    if not line:
        continue
    c = json.loads(line)
    chunks[c["doc_id"]].append(c)

pool = {d: cs for d, cs in chunks.items() if d not in seen}


def likely(cs):
    deg = kw = n6 = 0
    for c in cs:
        t = c["text"]
        deg += len(DEG.findall(t))
        kw += len(KW.findall(t))
        n6 += len(NUM6.findall(t))
    return deg > 0 or (kw > 0 and n6 > 0)


K = sorted(d for d, cs in pool.items() if likely(cs))
O = sorted(d for d in pool if d not in set(K))
rnd = random.Random(a.seed)
O_sample = sorted(rnd.sample(O, min(a.n_other, len(O))))

manifest = {
    "pool_docs": len(pool),
    "excluded_seen": len(set(chunks) - set(pool)),
    "strata": {
        "K": {"docs": len(K), "sampled": len(K), "weight": 1.0,
              "chunks": sum(len(pool[d]) for d in K), "doc_ids": K},
        "O": {"docs": len(O), "sampled": len(O_sample), "weight": len(O) / len(O_sample),
              "chunks": sum(len(pool[d]) for d in O_sample), "doc_ids": O_sample},
    },
    "seed": a.seed,
}

for name, ids in (("K", K), ("O", O_sample)):
    path = f"{a.out_dir}/chunks-pool4-{name}.jsonl"
    with open(path, "w", encoding="utf8") as f:
        for d in ids:
            for c in pool[d]:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
    st = manifest["strata"][name]
    print(f"слой {name}: {st['sampled']}/{st['docs']} док., {st['chunks']} кусков, вес {st['weight']:.3f} → {path}")

with open(f"{a.out_dir}/pool4-manifest.json", "w", encoding="utf8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)
print(f"манифест → {a.out_dir}/pool4-manifest.json")
