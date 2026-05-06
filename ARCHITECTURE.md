# Архитектура

Документ для разработчиков. Описывает устройство кода, схему общения
расширения с сервером, и где менять что.

## Общая схема

```
┌────────────────────┐     HTTP      ┌──────────────────────┐
│  Chrome Extension  │ ────────────> │   Python Server      │
│  (background +     │ <──────────── │   (server.py)        │
│   popup +          │     JSON      │                      │
│   options)         │               │   ┌────────────────┐ │
└────────────────────┘               │   │  Worker thread │ │
                                     │   │  (queue, 1 at  │ │
                                     │   │   a time)      │ │
                                     │   └───────┬────────┘ │
                                     │           │          │
                                     │           v          │
                                     │   ┌────────────────┐ │
                                     │   │  yt-dlp.exe    │ │
                                     │   │  (subprocess)  │ │
                                     │   └────────────────┘ │
                                     └──────────────────────┘
```

Расширение знает только про сервер (`http://127.0.0.1:5000`). Сервер знает
про `yt-dlp.exe` (запускает его как subprocess). yt-dlp знает про сайты,
прокси, и формат вывода.

## Структура репозитория

```
yt-dlp-chrome-bridge/
├── server.py              ← Python-сервер с очередью
├── start-server.bat       ← двойной клик для запуска
├── config.example.json    ← пример конфига (коммитится)
├── config.json            ← локальный конфиг (gitignore)
├── README.md              ← русская инструкция
├── README.en.md           ← английская инструкция
├── ARCHITECTURE.md        ← этот файл
├── LICENSE                ← MIT
├── .gitignore
└── extension/
    ├── manifest.json
    ├── config.js          ← единый источник SERVER_URL
    ├── background.js      ← service worker, контекстное меню, classifyUrl
    ├── popup.html / .css / .js   ← попап с очередью и формой
    ├── options.html / .css / .js ← страница настроек
    └── icon.png
```

## Сервер

### Конфигурация

`server.py` при старте читает `config.json`. Если файла нет — копирует
`config.example.json` → `config.json` и просит пользователя отредактировать.

Конфиг минимальный:

| Поле | Тип | Назначение |
|---|---|---|
| `yt_dlp_dir` | string | Папка с `yt-dlp.exe`, `ffmpeg.exe`, `yt-dlp.conf` |
| `host` | string | На каком интерфейсе слушать (default `127.0.0.1`) |
| `port` | int | Порт (default `5000`) |
| `keep_finished` | int | Сколько последних завершённых задач хранить в памяти |
| `log_retention_days` | int | Удалять логи старше N дней при старте |

`yt-dlp.conf` — отдельный файл yt-dlp, лежит в `yt_dlp_dir`. Сервер его
не трогает; он просто запускает `yt-dlp.exe` с рабочей папкой `yt_dlp_dir`,
поэтому конфиг подхватывается автоматически.

### Очередь и воркер

```python
_task_queue = queue.Queue()  # FIFO
_pending = []                # ожидающие задачи (для UI)
_current = None              # текущая задача (одна)
_finished = []               # история (limited)
```

Один поток-воркер (`worker_loop`) забирает задачи из `_task_queue` по одной.
Параллельных скачиваний нет — это сделано чтобы не плодить запросы через
прокси и не словить rate limit. Между задачами — паузы из `yt-dlp.conf`
(или те, что прислало расширение).

### HTTP API

Стандартный `http.server.ThreadingHTTPServer`, без сторонних библиотек.

| Endpoint | Метод | Назначение |
|---|---|---|
| `/ping` | GET | Версия сервера, для проверки что он жив |
| `/queue` | GET | Снимок очереди + текущая задача + история |
| `/settings` | GET/POST | Глобальные настройки (контейнер, паузы, формат) |
| `/version` | GET | Версия yt-dlp.exe (с кэшем по mtime) |
| `/update` | POST | Поставить в очередь обновление yt-dlp |
| `/download` | POST | Поставить в очередь задачу скачивания |
| `/cancel` | POST | Отменить задачу по id |
| `/cancel-all` | POST | Отменить все pending задачи |
| `/restart` | POST | Повторить ранее завершённую задачу |
| `/clear-finished` | POST | Очистить историю |

### Payload `/download`

```json
{
  "url": "https://...",
  "mode": "video",        // "video" | "audio" | "playlist" | "channel"
  "quality": "1080",      // для video: best | 2160 | 1440 | 1080 | 720 | 480
  "audio_format": "mp3",  // для audio: mp3 | opus | m4a | wav
  "audio_quality": "0",   // для audio: 0 (VBR) | 320K | 192K | 128K
  "range": "all",         // для playlist/channel: all | N | "1-10,15"
  "format": "video",      // для playlist/channel: video | video-best | mp3 | opus | m4a
  "subfolder": true,      // для playlist/channel: создавать ли отдельную папку
  "container": "both",    // mp4 | mkv | both
  "use_archive": true,    // false → --no-download-archive
  "sleep": "config",      // "config" | "none" | int (секунды)
  "tab_title": "..."      // заголовок вкладки браузера, для UI очереди
}
```

Любое поле кроме `url` и `mode` — опциональное. Если не передано, сервер
берёт значение из глобальных настроек или из `yt-dlp.conf`.

### Сборка команды yt-dlp

`build_command(payload)` собирает массив аргументов из payload. Хелперы:

- `quality_args` — `-f bv*[height<=N]+ba/b[height<=N]`
- `audio_args` — `-x --audio-format X --audio-quality Y`
- `container_args` — `--merge-output-format mp4 --remux-video mp4` etc.
- `archive_args` — `--no-download-archive` если выключено
- `sleep_args` — три флага паузы при `sleep != "config"`
- `format_to_args` — выбор `quality_args` vs `audio_args` для playlist/channel
- `playlist_range_args` — `-I 1:10` или `-I 1-10,15`

Подпапки для плейлистов и каналов передаются через `-o` (не `-P`):

```
playlist/%(playlist_title|Playlist).200B/%(playlist_index)02d - %(title).200B.%(ext)s
channel/%(channel|Unknown).200B/%(title).200B.%(ext)s
```

Это переопределяет `-o` из `yt-dlp.conf` (yt-dlp использует последний
переданный). Базовая папка (`-P`) остаётся из конфига.

### Парсер прогресса

`parse_progress_line` ловит строки вида `[download]   42.3% of 12.34MiB at ...`
и `[download] Downloading item 3 of 10`. Результат пишется в
`task["progress"] = {percent, filename, playlist_n, playlist_total}` и
отдаётся через `/queue`.

### Логи

Каждая задача пишет лог в `<yt_dlp_dir>/logs/NNNN.log` где NNNN — id задачи.
При старте сервера:

1. Файлы старше `LOG_RETENTION_DAYS` удаляются.
2. Среди оставшихся ищется максимальный N. `_next_id` стартует с N+1, чтобы
   старые логи не затирались.

## Расширение

### config.js

Единственное место где задаётся URL сервера. Подключается:

- В service worker (`background.js`) через `importScripts("config.js")`
- В HTML (`popup.html`, `options.html`) через `<script src="config.js">`

`popup.js`, `options.js`, `background.js` читают `globalThis.YTDLP_BRIDGE_CONFIG.SERVER_URL`
с fallback на хардкод `http://127.0.0.1:5000` если config.js по какой-то
причине не подгрузился.

### background.js

Service worker. Обязанности:

1. **classifyUrl**: разбор URL → `{kind, site, url}`. Шесть отдельных
   функций для каждого сайта (`classifyYouTube`, `classifyTwitter` и т.д.).
   Главная `classifyUrl` пробует все по очереди.
2. **Контекстное меню**: два пункта (на ссылке и на странице) для
   поддерживаемых доменов. При клике — POST `/download` с дефолтами,
   без открытия попапа.
3. **Сообщения от попапа**: `chrome.runtime.onMessage` принимает
   `{type: "classify", url}` и возвращает результат `classifyUrl(url)`.

### popup.js

Логика попапа. При открытии:

1. Получает активную вкладку (`chrome.tabs.query`)
2. Передаёт URL в `classifyUrl` через message → background.js
3. Если ютуб/твиттер/итд → подставляет URL и тип в форму
4. Иначе → показывает поле для ручной вставки
5. Параллельно подгружает дефолты из `/settings`
6. Регулярно (каждые 1.5 сек) дёргает `/queue` для обновления списка

При клике "Скачать":

1. Собирает payload из формы
2. POST `/download`
3. Обновляет очередь

### options.js

Страница настроек. POST `/settings` при «Сохранить». При загрузке —
GET `/version` для отображения текущей версии yt-dlp.

## Авто-определение URL

`classifyUrl(url)` возвращает `{kind, site, url}`:

- `kind`: `"video"` | `"playlist"` | `"channel"`
- `site`: `"youtube"` | `"twitter"` | `"twitch"` | `"soundcloud"` | `"reddit"` | `"instagram"` | `null`
- `url`: канонизированный URL (например `youtu.be/X` → `youtube.com/watch?v=X`)

Если URL не относится ни к одному из 6 сайтов — `null`. Это означает «нет
автоматического распознавания», но скачивать его всё равно можно — yt-dlp
сам определит экстрактор.

## Важные детали

### Почему один воркер а не пул

Параллельные скачивания через прокси с одного IP — это путь к бану.
Особенно на YouTube. Один воркер + паузы из `yt-dlp.conf` имитируют
поведение человека.

### Почему контент-скриптов нет

Раньше в расширении была кнопка под видео на YouTube (через content script).
Удалена в v2.3 потому что:

- YouTube часто меняет вёрстку → кнопка ломается → ручной фикс
- На других сайтах вёрстка ещё сложнее, унифицировать невозможно
- Иконка в панели Chrome всегда в одном месте, попап удобнее

### Почему `-o`, а не `-P` для подпапок плейлиста

`-P` (path) **не парсит шаблоны output template**. Если передать
`-P "playlist/%(playlist_title)s"` — yt-dlp создаст буквально папку с
именем `%(playlist_title)s`. Шаблоны работают только в `-o`. Поэтому для
подпапок мы добавляем `-o` который переопределяет `-o` из `yt-dlp.conf`.

### Почему именно `playlist_index` без `id` в имени файла

Раньше в шаблоне был `[%(id)s]` для избежания коллизий. Имена выглядели
как `пришельцы 1 [2246807162].mp3` — некрасиво. Заменили на префикс
`%(playlist_index)02d - ` для плейлистов: коллизии исключены (индексы
уникальны в рамках плейлиста), нумерация удобна для альбомов. Для каналов
нумерации нет (видео могут добавляться/удаляться, порядок плавающий).

### Кэш версии yt-dlp

`get_yt_dlp_version()` запускает `yt-dlp.exe --version` и кэширует результат
по `mtime` файла. После `yt-dlp -U` mtime меняется → кэш инвалидируется
автоматически. Это позволяет дёргать `/version` часто без накладных расходов.

### Обновление через очередь, а не отдельным потоком

Когда расширение POST'ит `/update`, в очередь ставится спец-задача
`mode: "update"` с командой `[YT_DLP_EXE, "-U"]`. Это гарантирует что
обновление не пересечётся с активным скачиванием — `yt-dlp.exe` перезаписывает
сам себя при `-U`, и параллельный запуск этого же файла мог бы всё сломать.

## Расширение проекта

### Добавить новый сайт в авто-определение

В `extension/background.js` написать функцию `classifyMysite(host, u)`,
вернуть `{kind, site, url}` или `null`. Подключить в `classifyUrl`. В
`SITE_PATTERNS` добавить URL-паттерны для контекстного меню. В
`popup.html` `dl-context` empty-state список сайтов можно дополнить.

### Добавить новую опцию скачивания

1. В `popup.html` добавить контрол
2. В `popup.js` обработчик «Скачать» прокинуть значение в payload
3. В `server.py` `build_command` подцепить новый ключ payload и добавить
   соответствующие флаги yt-dlp
4. (Опционально) В `options.html` + `options.js` + `server.py` `/settings`
   добавить как глобальный дефолт

### Добавить эндпоинт

В `server.py` `Handler.do_POST` или `do_GET` добавить ветку. Использовать
`self._send_json(code, dict)` для ответа.
