#!/usr/bin/env python3
"""
Python privacy-сайдкар — русский NER высокого recall (Natasha).

Опциональный upgrade поверх TS-дефолта. Общается с Bun-раннером по
JSON-newline через stdin/stdout — тот же протокол, что мок-сайдкары в __fixtures__:
    запрос:  {"id":N,"method":"health|deid","params":{...}}\\n
    ответ:   {"id":N,"ok":true,"result":{...}}\\n | {"id":N,"ok":false,"error":"..."}\\n

Natasha даёт PER/ORG/LOC. Отдаём PER и ORG (даты/№дел закрывает TS-regex на раннере).
Если natasha не установлена/модели не загрузились → health отвечает ok:false,
раннер помечает сайдкар 'down' и остаётся на TS-дефолте (fail-closed-совместимо).

Упаковка/антивирус/доставка — вместе с бинарём раннера. Валидация recall на реальных
отчётах — отдельная задача (см. py-sidecar/README.md).
"""

import sys
import json

_NER = None          # ленивая инициализация тяжёлых моделей
_NER_ERROR = None


def _load_ner():
    """Грузит модели Natasha один раз. Ошибку кладём в _NER_ERROR (health→ok:false)."""
    global _NER, _NER_ERROR
    if _NER is not None or _NER_ERROR is not None:
        return
    try:
        from natasha import Segmenter, NewsEmbedding, NewsNERTagger, Doc  # type: ignore

        segmenter = Segmenter()
        tagger = NewsNERTagger(NewsEmbedding())
        _NER = (segmenter, tagger, Doc)
    except Exception as e:  # noqa: BLE001 — любой сбой импорта/загрузки = сайдкар down
        _NER_ERROR = str(e)


# Natasha-тип → наш EntityType
_TYPE_MAP = {"PER": "PER", "ORG": "ORG"}


def _deid(text, types):
    """Возвращает [{type, raw, index, confidence}] для запрошенных типов."""
    _load_ner()
    if _NER is None:
        raise RuntimeError(f"natasha недоступна: {_NER_ERROR}")
    segmenter, tagger, Doc = _NER
    doc = Doc(text)
    doc.segment(segmenter)
    doc.tag_ner(tagger)
    wanted = set(types)
    out = []
    for span in doc.spans:
        etype = _TYPE_MAP.get(span.type)
        if etype is None or etype not in wanted:
            continue
        out.append(
            {
                "type": etype,
                "raw": span.text,
                "index": span.start,
                "confidence": "high",
            }
        )
    return out


def _handle(req):
    method = req.get("method")
    params = req.get("params") or {}
    if method == "health":
        _load_ner()
        if _NER_ERROR is not None:
            return {"ok": False, "error": _NER_ERROR}
        return {"ok": True, "result": {"ok": True}}
    if method == "deid":
        entities = _deid(params.get("text", ""), params.get("types", ["PER", "ORG"]))
        return {"ok": True, "result": {"entities": entities}}
    return {"ok": False, "error": f"unknown method: {method}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        try:
            resp = _handle(req)
        except Exception as e:  # noqa: BLE001
            resp = {"ok": False, "error": str(e)}
        resp["id"] = rid
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
