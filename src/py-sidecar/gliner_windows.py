"""Lossless overlapping windows for GLiNER 0.2.x.

GLiNER truncates overlong input without returning coverage metadata. Privacy
cannot accept a silent tail drop, so every call is split before inference and
predictions are mapped back to document character offsets.
"""

from __future__ import annotations

import re


def text_windows(text: str, max_words: int = 320, overlap_words: int = 64):
    if max_words <= 0 or overlap_words < 0 or overlap_words >= max_words:
        raise ValueError("require max_words > overlap_words >= 0")
    words = list(re.finditer(r"\S+", text))
    if not words:
        return []
    windows = []
    step = max_words - overlap_words
    for first in range(0, len(words), step):
        last = min(first + max_words, len(words))
        start = words[first].start()
        end = words[last - 1].end()
        windows.append({"text": text[start:end], "start": start, "end": end})
        if last == len(words):
            break
    if windows[0]["start"] != words[0].start() or windows[-1]["end"] != words[-1].end():
        raise RuntimeError("window coverage invariant failed")
    return windows


def predict_windowed(model, text, labels, threshold, max_words=320, overlap_words=64):
    dedup = {}
    windows = text_windows(text, max_words=max_words, overlap_words=overlap_words)
    for window in windows:
        for span in model.predict_entities(window["text"], labels, threshold=threshold):
            item = dict(span)
            item["start"] += window["start"]
            item["end"] += window["start"]
            item["text"] = text[item["start"]:item["end"]]
            key = (item["start"], item["end"], item["label"])
            previous = dedup.get(key)
            if previous is None or item.get("score", 0) > previous.get("score", 0):
                dedup[key] = item
    return sorted(
        dedup.values(),
        key=lambda item: (item["start"], item["end"], item["label"]),
    )
