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
import os
import re
import gc
from pathlib import Path
from gliner_windows import predict_windowed

_NER = None          # ленивая инициализация тяжёлых моделей
_NER_ERROR = None
_MORPH = None
_GLINER = None
_GLINER_ERROR = None
_GLINER_MODEL = None
_GLINER_PROFILE = None
_GLINER_CONFIG = None


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

# Natasha обучена на новостях и на отраслевом отчёте зовёт человеком любое слово с
# заглавной в начале предложения («Камеральная», «Оруденение», «Автор»), а
# организацией — служебные поля вёрстки («PAGEREF», «REF») и номер лицензии. На
# ручном эталоне это давало точность 0.80 и роняло точность связки с 0.96 до 0.79.
# Поэтому берём у неё только то, что она умеет лучше модели: подпись «Фамилия И.О.»
# и юрлицо с организационно-правовой формой. Голые фамилии оставлены модели —
# у Natasha они как раз и оказывались ложными.
_INITIALS = r"(?:[А-ЯЁ]\.\s?){1,3}[А-ЯЁ]?(?![а-яё])"
_SURNAME = r"[А-ЯЁ][а-яё]{2,}(?:-[А-ЯЁ][а-яё]+)?"
_PERSON_WITH_INITIALS = re.compile(
    rf"^(?:{_SURNAME}\s*,?\s*{_INITIALS}|{_INITIALS}\s*{_SURNAME})$"
)
# Полное ФИО — каноническая форма персональных данных, её тоже берём. Якорь —
# отчество: без него «Булун- Визуальная» и прочие пары слов с заглавной прошли бы.
_PERSON_FULL_NAME = re.compile(
    r"^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:ович|евич|ьич|ич|овна|евна|ична|инична)$"
    r"|^[А-ЯЁ][а-яё]+(?:ович|евич|ьич|ич|овна|евна|ична|инична)\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$"
)
_LEGAL_FORM = re.compile(r"\b(ООО|ОАО|ЗАО|ПАО|АО|ГПП|ГУП|ФГУП|ФГБУ|НИИ|АНО|НПО|НПЦ|ФКУ|МУП)\b")
_ABBREVIATION = re.compile(r"^[А-ЯЁ]{4,}$")
# Служебные поля Word и коды сертификатов, которые Natasha принимает за организацию.
_LAYOUT_ARTIFACTS = {"REF", "PAGEREF", "TOC", "MERGEFORMAT", "РОСС", "НТС", "RU", "OGTR"}


def _known_russian_word(value):
    """Обычное слово словаря или всё-таки аббревиатура? «НЕДРА» — слово, «СВКНИИ» — нет."""
    try:
        return any(parse.is_known for parse in _morph().parse(value.lower()))
    except Exception:  # noqa: BLE001 — морфология недоступна, решает остальная логика
        return False


def _valid_natasha_entity(entity_type, raw):
    value = re.sub(r"\s+", " ", raw.replace("\n", " ")).strip()
    if entity_type == "PER":
        return bool(_PERSON_WITH_INITIALS.match(value) or _PERSON_FULL_NAME.match(value))
    if entity_type != "ORG":
        return True
    value = value.strip(" «»\"'()")
    words = value.split()
    if not words or any(word in _LAYOUT_ARTIFACTS for word in words):
        return False
    if _LEGAL_FORM.search(value):
        return True
    return bool(_ABBREVIATION.match(words[0])) and not _known_russian_word(words[0])


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
        if not _valid_natasha_entity(etype, span.text):
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


def _profile_config(vertical):
    config_file = os.environ.get("PRIVACY_GLINER_MODELS_CONFIG")
    if not config_file:
        model = os.environ.get(
            "PRIVACY_GLINER_MODEL",
            "knowledgator/gliner-pii-base-v1.0",
        )
        return {
            "profile": vertical,
            "model": model,
            "display_model": model,
            "threshold": float(os.environ.get("PRIVACY_GLINER_THRESHOLD", "0.3")),
            "labels": _gliner_labels(vertical),
            "status": "legacy-single-model",
            "local_only": False,
        }

    path = Path(config_file)
    profiles = json.loads(path.read_text(encoding="utf-8"))
    if vertical not in profiles:
        raise ValueError(f"профиль {vertical!r} отсутствует в {path.name}")
    raw = profiles[vertical]
    model = raw.get("model")
    if not isinstance(model, str) or not model:
        raise ValueError(f"профиль {vertical!r}: model обязателен")
    model_path = Path(model)
    if not model_path.is_absolute():
        model_path = (path.parent / model_path).resolve()
    if not model_path.is_dir():
        raise FileNotFoundError(f"профиль {vertical!r}: локальная модель не найдена")
    labels = raw.get("labels", _gliner_labels(vertical))
    if not isinstance(labels, dict) or not labels:
        raise ValueError(f"профиль {vertical!r}: labels должен быть непустым объектом")
    return {
        "profile": vertical,
        "model": str(model_path),
        "display_model": model,
        "threshold": float(raw.get("threshold", 0.5)),
        "labels": labels,
        "status": raw.get("status", "not-specified"),
        "local_only": True,
    }


def _release_gliner():
    global _GLINER, _GLINER_MODEL, _GLINER_CONFIG
    _GLINER = None
    _GLINER_MODEL = None
    _GLINER_CONFIG = None
    gc.collect()


def _load_gliner(vertical):
    global _GLINER, _GLINER_ERROR, _GLINER_MODEL, _GLINER_PROFILE, _GLINER_CONFIG
    config = _profile_config(vertical)
    if _GLINER is not None and _GLINER_MODEL == config["model"]:
        _GLINER_PROFILE = vertical
        _GLINER_CONFIG = config
        _GLINER_ERROR = None
        return config
    _release_gliner()
    _GLINER_PROFILE = vertical
    _GLINER_ERROR = None
    try:
        from gliner import GLiNER  # type: ignore
        onnx_file = os.environ.get("PRIVACY_GLINER_ONNX")
        _GLINER = GLiNER.from_pretrained(
            config["model"],
            load_onnx_model=bool(onnx_file),
            onnx_model_file=onnx_file or "model.onnx",
            local_files_only=config["local_only"],
        )
        _GLINER_MODEL = config["model"]
        _GLINER_CONFIG = config
        return config
    except Exception as e:  # noqa: BLE001
        _GLINER_ERROR = str(e)
        raise RuntimeError(f"GLiNER недоступен для профиля {vertical}: {_GLINER_ERROR}") from e


def _gliner_labels(vertical):
    path = Path(__file__).with_name("labels.json")
    labels = json.loads(path.read_text(encoding="utf-8"))
    return labels.get(vertical, labels["common"])


def _valid_gliner_entity(entity_type, raw):
    value = raw.strip()
    if entity_type == "FIELD":
        lowered = value.lower()
        if re.fullmatch(r"(?:участк\w*\s+недр|добыч\w*\s+полезн\w*\s+ископаем\w*)", lowered):
            return False
        if re.fullmatch(r".+\s+(?:залив\w*|област\w*|район\w*)", lowered):
            return False
        return True
    if entity_type != "PER":
        return True
    if re.search(r"\d", value) or not re.fullmatch(r"[А-ЯЁа-яё .'-]+", value):
        return False
    if re.match(r"(?i)^(полис|карта|паспорт|автомобиль|лицензия|договор)\b", value):
        return False
    if re.fullmatch(r"(?i)(?:недропользовател|представител|заявител|исполнител|пользовател)\w*", value):
        return False
    return bool(re.search(r"\b[А-ЯЁ][а-яё]{1,}\b", value))


def _deid_gliner(text, vertical):
    config = _load_gliner(vertical)
    mapping = config["labels"]
    reverse = {label: entity_type for entity_type, label in mapping.items()}
    out = []
    threshold = config["threshold"]
    max_words = int(os.environ.get("PRIVACY_GLINER_WINDOW_WORDS", "320"))
    overlap_words = int(os.environ.get("PRIVACY_GLINER_WINDOW_OVERLAP", "64"))
    for span in predict_windowed(
        _GLINER,
        text,
        list(reverse),
        threshold=threshold,
        max_words=max_words,
        overlap_words=overlap_words,
    ):
        entity_type = reverse.get(span["label"])
        if entity_type is None or not _valid_gliner_entity(entity_type, span["text"]):
            continue
        out.append({
            "type": entity_type,
            "raw": span["text"],
            "index": span["start"],
            "confidence": "high" if span.get("score", 0) >= 0.7 else "medium",
        })
    return out


_CASE_MAP = {
    "nomn": "nom",
    "gent": "gen",
    "datv": "dat",
    "accs": "acc",
    "ablt": "ins",
    "loct": "loc",
}


def _morph():
    global _MORPH
    if _MORPH is None:
        import pymorphy3  # type: ignore
        _MORPH = pymorphy3.MorphAnalyzer()
    return _MORPH


def _morph_analyze(text):
    word = text.strip().split()[0] if text.strip() else ""
    if not word:
        return None
    parsed = _morph().parse(word)[0]
    return {
        "lemma": parsed.normal_form,
        "form": {
            "case": _CASE_MAP.get(parsed.tag.case),
            "gender": {"masc": "masc", "femn": "femn", "neut": "neut"}.get(parsed.tag.gender),
            "number": {"sing": "sing", "plur": "plur"}.get(parsed.tag.number),
        },
    }


def _handle(req):
    method = req.get("method")
    params = req.get("params") or {}
    if method == "health":
        engine = os.environ.get("PRIVACY_NER_ENGINE", "natasha")
        vertical = params.get("vertical") or _GLINER_PROFILE or os.environ.get("PRIVACY_VERTICAL", "common")
        if engine in {"natasha", "both"}:
            _load_ner()
        config = None
        if engine in {"gliner", "both"}:
            try:
                config = _profile_config(vertical)
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": str(e)}
        if engine == "natasha" and _NER_ERROR is not None:
            return {"ok": False, "error": _NER_ERROR}
        return {
            "ok": True,
            "result": {
                "ok": True,
                "natasha": _NER_ERROR is None,
                "gliner": bool(config),
                "active_profile": vertical,
                "model": config["display_model"] if config else None,
                "threshold": config["threshold"] if config else None,
                "model_status": (
                    "loaded"
                    if config and _GLINER is not None and _GLINER_MODEL == config["model"]
                    else "unloaded"
                ),
                "release_status": config["status"] if config else None,
            },
        }
    if method == "deid":
        entities = _deid(params.get("text", ""), params.get("types", ["PER", "ORG"]))
        return {"ok": True, "result": {"entities": entities}}
    if method == "deid_gliner":
        entities = _deid_gliner(
            params.get("text", ""),
            params.get("vertical", "common"),
        )
        return {"ok": True, "result": {"entities": entities}}
    if method == "morph_analyze":
        return {"ok": True, "result": _morph_analyze(params.get("text", ""))}
    if method == "agree_with_number":
        parsed = _morph().parse(params.get("lemma", ""))[0]
        agreed = parsed.make_agree_with_number(int(params.get("n", 0)))
        return {"ok": True, "result": {"value": agreed.word if agreed else parsed.word}}
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
