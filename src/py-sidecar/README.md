# Python privacy-сайдкар — переключаемые локальные NER-модели

Высокорекольный русский NER (Natasha ~95% F1) поверх TS-дефолта (`../deid/detect.ts`).
Ставится **только по желанию** клиента — без него работает TS-путь.

## Протокол
JSON-newline по stdin/stdout (тот же, что мок-сайдкары в `../__fixtures__`):
```
→ {"id":1,"method":"health","params":{}}
← {"id":1,"ok":true,"result":{"ok":true}}
→ {"id":2,"method":"deid","params":{"text":"...","types":["PER","ORG"]}}
← {"id":2,"ok":true,"result":{"entities":[{"type":"PER","raw":"...","index":N,"confidence":"high"}]}}
```
Natasha даёт PER/ORG (даты/№дел закрывает TS-regex на раннере).

## Запуск (раннер поднимает сам через Bun.spawn)
```
cp src/py-sidecar/models.example.json src/py-sidecar/models.json
PRIVACY_NER_ENGINE=both \
PRIVACY_GLINER_MODELS_CONFIG=src/py-sidecar/models.json \
PRIVACY_SIDECAR_CMD=".venv-privacy/bin/python src/py-sidecar/natasha_sidecar.py" \
bun run start
```

Пути в `models.json` разрешаются относительно самого файла, поэтому в git не
нужны абсолютные машинные пути. Каждый профиль задаёт `model`, `labels`,
`threshold` и честный `status`. GLiNER грузится только при первом запросе.
Одновременно в памяти находится не более одного тяжёлого веса; общий path
между профилями переиспользуется.

Обратная совместимость:

```bash
PRIVACY_GLINER_MODEL=artifacts/local-model \
PRIVACY_GLINER_THRESHOLD=0.4
```

## Установка
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```
При первом `deid` Natasha тянет модели (navec/slovnet, ~50–100МБ) — доставка вместе
с бинарём раннера, подпись бинаря + whitelist Defender.

## Health и fail-closed

Health показывает `active_profile`, `model`, `threshold`, `model_status` и
`release_status`, не загружая тяжёлый вес заранее. Если профиль настроен на
GLiNER, но модель отсутствует или не загрузилась, Natasha и TypeScript rules
могут выполнить локальный fallback, однако внешний egress блокируется:
техническая ошибка не разрешает отправку сырого текста.

## Статус верификации
- ✅ Протокол + graceful-degrade — смоук пройден локально.
- 📐 Recall на геологических отчётах — методология и инструмент готовы, сам замер
  ждёт стенд с установленной `natasha`. См. [`VALIDATION.md`](VALIDATION.md)
  (что такое precision/recall/F1 здесь, почему recall важнее F1, честные
  ограничения синтетической фикстуры) и `validate_recall.py`
  (готовый скрипт: `python3 validate_recall.py` — печатает таблицу
  precision/recall/F1 по типам PER/ORG на синтетической фикстуре
  `fixtures/geo_report_sample.jsonl`, добавьте `--json out.json` для
  машиночитаемого вывода). Заявленные ~95% F1 — цифра с новостного
  бенчмарка Natasha, не измерена на геологических текстах.
