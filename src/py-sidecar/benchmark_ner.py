#!/usr/bin/env python3
"""Reproducible CPU benchmark for Phase 5. Downloads nothing implicitly except model loading."""

import argparse
import json
import os
import resource
import statistics
import sys
import time
from pathlib import Path

import natasha_sidecar as sidecar


def bench(name, predict, text, runs):
    samples = []
    prediction = []
    for _ in range(runs):
        started = time.perf_counter()
        prediction = predict(text)
        samples.append(time.perf_counter() - started)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_mb = peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024
    return {
        "model": name,
        "seconds_per_3000_chars_median": statistics.median(samples),
        "ram_peak_mb": peak_mb,
        "entities": len(prediction),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["natasha", "gliner"], required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--json")
    args = parser.parse_args()
    text = (
        "Отчёт Иванов И.И. для ООО «ГеоТест». Скважина №A-12 расположена "
        "на месторождении Северное. "
    )
    text = (text * (3000 // len(text) + 1))[:3000]
    if args.engine == "natasha":
        result = bench("slovnet/natasha", lambda value: sidecar._deid(value, ["PER", "ORG"]), text, args.runs)
    else:
        result = bench(
            os.environ.get("PRIVACY_GLINER_MODEL", "knowledgator/gliner-pii-base-v1.0"),
            lambda value: sidecar._deid_gliner(value, "geo"),
            text,
            args.runs,
        )
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    print(payload)
    if args.json:
        Path(args.json).write_text(payload + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
