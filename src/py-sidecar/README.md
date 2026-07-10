# Python privacy-сайдкар — опциональный upgrade

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
PRIVACY_SIDECAR_CMD="python3 src/py-sidecar/natasha_sidecar.py" bun run start
```

## Установка
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```
При первом `deid` Natasha тянет модели (navec/slovnet, ~50–100МБ) — доставка вместе
с бинарём раннера, подпись бинаря + whitelist Defender.

## Fail-closed
natasha не установлена / модели не загрузились → `health` отвечает `ok:false`,
`SidecarManager` помечает сайдкар `down`, `text-deid` остаётся на TS-дефолте.
Проверено локально (health без natasha → `{"ok":false,"error":"No module named 'natasha'"}`).

## Статус верификации
- ✅ Протокол + graceful-degrade — смоук пройден локально.
- ⏳ Recall Natasha на РЕАЛЬНЫХ геологических отчётах — план валидации recall
  на реальном стенде. Заявленные ~95% F1 — на news-бенчмарке, не на недрах.
