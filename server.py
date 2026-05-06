# -*- coding: utf-8 -*-
"""
yt-dlp Chrome Bridge — локальный сервер (v2.6)

Мост между Chrome-расширением и yt-dlp.exe. Очередь, прогресс, настройки,
автообновление yt-dlp, поддержка YouTube + 1800 других сайтов.

См. README.md, ARCHITECTURE.md в корне репозитория.

Что нового в v2.6:
  - Конфиг вынесен в config.json (рядом с server.py).
    При первом запуске копируется из config.example.json.
    Захардкоженный путь YT_DLP_DIR убран.
"""

import json
import re
import shutil
import subprocess
import sys
import os
import threading
import queue
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# === Загрузка конфигурации ===
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
CONFIG_EXAMPLE_PATH = os.path.join(SCRIPT_DIR, "config.example.json")


def load_config():
    """
    Загружает config.json. Если его нет — копирует из config.example.json
    и просит пользователя отредактировать. Если и примера нет — фатальная
    ошибка (репо побит).
    """
    if not os.path.isfile(CONFIG_PATH):
        if not os.path.isfile(CONFIG_EXAMPLE_PATH):
            print("[!] FATAL: ни config.json, ни config.example.json не найдены.")
            print(f"    Ожидаемые пути:")
            print(f"      {CONFIG_PATH}")
            print(f"      {CONFIG_EXAMPLE_PATH}")
            sys.exit(1)
        print(f"[i] config.json не найден, копирую из config.example.json")
        shutil.copy(CONFIG_EXAMPLE_PATH, CONFIG_PATH)
        print(f"[!] ОТКРОЙ {CONFIG_PATH} И УКАЖИ СВОЙ yt_dlp_dir, потом перезапусти сервер.")
        sys.exit(0)

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:
        print(f"[!] FATAL: не могу прочитать {CONFIG_PATH}: {e}")
        sys.exit(1)

    # Минимальная валидация
    yt_dlp_dir = cfg.get("yt_dlp_dir")
    if not yt_dlp_dir or not isinstance(yt_dlp_dir, str):
        print(f"[!] FATAL: в {CONFIG_PATH} отсутствует поле 'yt_dlp_dir' (строка с путём).")
        sys.exit(1)
    if not os.path.isdir(yt_dlp_dir):
        print(f"[!] FATAL: yt_dlp_dir = {yt_dlp_dir!r} — папка не существует.")
        print(f"    Поправь {CONFIG_PATH} или создай эту папку (внутри должен быть yt-dlp.exe).")
        sys.exit(1)

    return cfg


_cfg = load_config()

# === Применённая конфигурация ===
YT_DLP_DIR = _cfg["yt_dlp_dir"]
YT_DLP_EXE = os.path.join(YT_DLP_DIR, "yt-dlp.exe")
LOGS_DIR = os.path.join(YT_DLP_DIR, "logs")
SETTINGS_FILE = os.path.join(YT_DLP_DIR, "yt-dlp-bridge-settings.json")

HOST = _cfg.get("host", "127.0.0.1")
PORT = int(_cfg.get("port", 5000))

KEEP_FINISHED = int(_cfg.get("keep_finished", 30))
LOG_RETENTION_DAYS = int(_cfg.get("log_retention_days", 30))

RANGE_RE = re.compile(r"^[\d,\-]+$")

# === Дефолтные настройки ===
# Это то, что будет использоваться если в settings.json нет соответствующего
# ключа. Пользователь может менять через POST /settings.
DEFAULT_SETTINGS = {
    "use_archive": True,         # True = как в конфиге; False = добавит --no-download-archive
    "container": "both",         # "mp4" | "mkv" | "both"
    "audio_format": "mp3",       # дефолт для аудио
    "audio_quality": "0",        # VBR
    "video_quality": "1080",     # дефолт для видео
    "sleep": "config",           # "config" | "none" | <строка с числом секунд>
}

_settings_lock = threading.Lock()
_settings = dict(DEFAULT_SETTINGS)


def load_settings():
    global _settings
    try:
        if os.path.isfile(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            with _settings_lock:
                _settings = {**DEFAULT_SETTINGS, **data}
            print(f"[settings] loaded from {SETTINGS_FILE}")
        else:
            save_settings()
    except Exception as e:
        print(f"[settings] load error: {e}, using defaults")


def save_settings():
    try:
        with _settings_lock:
            data = dict(_settings)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[settings] save error: {e}")


# === Версия yt-dlp ===
# Кэшируем mtime файла + распарсенную версию, чтобы не запускать
# процесс на каждый запрос /version. После успешного -U файл меняется,
# mtime тоже — кэш инвалидируется автоматически.
_version_cache = {"mtime": None, "version": None}
_version_lock = threading.Lock()


def get_yt_dlp_version():
    """Возвращает строку версии или None если бинарник не найден / не запускается."""
    if not os.path.isfile(YT_DLP_EXE):
        return None
    try:
        mtime = os.path.getmtime(YT_DLP_EXE)
    except OSError:
        return None

    with _version_lock:
        if _version_cache["mtime"] == mtime and _version_cache["version"]:
            return _version_cache["version"]

    try:
        proc = subprocess.run(
            [YT_DLP_EXE, "--version"],
            cwd=YT_DLP_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            timeout=10,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        version = proc.stdout.strip().splitlines()[-1] if proc.stdout else None
    except Exception as e:
        print(f"[version] error: {e}")
        return None

    with _version_lock:
        _version_cache["mtime"] = mtime
        _version_cache["version"] = version
    return version


# === Состояние очереди ===
_state_lock = threading.Lock()
_task_queue = queue.Queue()
_pending = []
_current = None
_finished = []
_next_id = [0]
_cancel_flag = {"id": None}


def short_title(payload):
    mode = payload.get("mode", "?")
    if mode == "update":
        return "🔄 Обновление yt-dlp"
    if mode == "video":
        return f"🎬 видео ({payload.get('quality', 'best')}p)"
    if mode == "audio":
        return f"🎵 {payload.get('audio_format', 'mp3')}"
    if mode == "playlist":
        return f"📃 плейлист ({payload.get('range', 'all')}, {payload.get('format', '?')})"
    if mode == "channel":
        return f"📺 канал ({payload.get('range', '?')}, {payload.get('format', '?')})"
    return mode


def quality_args(quality):
    if quality and quality != "best":
        return ["-f", f"bv*[height<={quality}]+ba/b[height<={quality}]"]
    return []


def audio_args(audio_format, audio_quality=""):
    args = ["-x", "--audio-format", audio_format or "mp3"]
    if audio_quality:
        args += ["--audio-quality", audio_quality]
    return args


def playlist_range_args(rng):
    if not rng or rng == "all":
        return []
    rng = rng.strip()
    if rng.isdigit():
        return ["--playlist-items", f"1-{rng}"]
    if not RANGE_RE.match(rng):
        return []
    return ["--playlist-items", rng]


def format_to_args(fmt):
    if fmt == "video":
        return quality_args("1080")
    if fmt == "video-best":
        return quality_args("best")
    if fmt in ("mp3", "opus", "m4a"):
        if fmt == "mp3":
            return audio_args("mp3", "0")
        return audio_args(fmt)
    return []


def container_args(container, is_audio):
    """
    container: "mp4" | "mkv" | "both"
    Для аудио ничего не делаем — там свой --audio-format.
    Для "both" не добавляем --merge-output-format, потому что
    конфиг пользователя уже задаёт mkv + --exec для копии в mp4.
    """
    if is_audio:
        return []
    if container == "mp4":
        return ["--merge-output-format", "mp4"]
    if container == "mkv":
        return ["--merge-output-format", "mkv"]
    # "both" — оставляем поведение из конфига
    return []


def archive_args(use_archive):
    """Если use_archive=False → форсируем игнор archive.txt для этой задачи."""
    if not use_archive:
        return ["--no-download-archive"]
    return []


def sleep_args(sleep):
    """
    sleep: "config" | "none" | int | str(int)
    "config" → ничего не возвращаем (работают значения из yt-dlp.conf).
    "none"   → 0 секунд во все три флага паузы.
    N (int)  → фиксированная пауза N секунд во все три флага.
               --sleep-interval N --max-sleep-interval N даёт ровно N сек
               (yt-dlp выбирает случайно из [min, max], при равных — всегда N).
    """
    if sleep is None or sleep == "config":
        return []
    # Преобразование к int. Принимаем и строки от клиента ("5", "10").
    if sleep == "none":
        n = 0
    else:
        try:
            n = int(sleep)
        except (TypeError, ValueError):
            return []  # некорректное значение — игнорируем
        if n < 0:
            n = 0
    return [
        "--sleep-interval", str(n),
        "--max-sleep-interval", str(n),
        "--sleep-requests", str(n),
    ]


def build_command(payload):
    mode = payload.get("mode", "video")
    url = payload.get("url", "").strip()

    # Спецрежим: обновление yt-dlp. Никаких видео-флагов, никакого URL.
    # Идёт через ту же очередь что и скачивания, чтобы гарантированно
    # не пересечься с активной загрузкой.
    if mode == "update":
        return [YT_DLP_EXE, "-U"]

    is_audio = mode == "audio"

    # Берём настройки задачи: что прислал клиент имеет приоритет,
    # иначе — глобальные дефолты.
    with _settings_lock:
        s = dict(_settings)

    use_archive = payload.get("use_archive", s["use_archive"])
    container = payload.get("container", s["container"])
    sleep = payload.get("sleep", s.get("sleep", "config"))
    sleep = payload.get("sleep", s.get("sleep", "config"))

    cmd = [YT_DLP_EXE]
    # Заставляем yt-dlp писать stdout/stderr в UTF-8.
    # Без этого на Windows вывод в pipe идёт в cp1251/cp866,
    # и кириллица превращается в "?????".
    cmd += ["--encoding", "utf-8"]

    # Исключаем чат прямых трансляций — это бесполезный .live_chat.json
    # на много мегабайт. Если в конфиге --embed-subs или --write-subs,
    # без этого флага качается весь чат стрима.
    cmd += ["--sub-langs", "all,-live_chat"]

    if mode == "video":
        cmd += quality_args(payload.get("quality", s["video_quality"]))
        cmd += ["--no-playlist"]
    elif mode == "audio":
        cmd += audio_args(
            payload.get("audio_format", s["audio_format"]),
            payload.get("audio_quality", s["audio_quality"]),
        )
        cmd += ["--no-playlist"]
        is_audio = True
    elif mode == "playlist":
        cmd += ["--yes-playlist"]
        cmd += playlist_range_args(payload.get("range", "all"))
        fmt = payload.get("format", "video")
        cmd += format_to_args(fmt)
        is_audio = fmt in ("mp3", "opus", "m4a")
        # Отдельная папка с именем плейлиста + нумерация треков.
        # ВАЖНО: шаблоны вида %(playlist_title)s работают ТОЛЬКО в -o,
        # в -P они не парсятся (yt-dlp создаст буквально папку
        # "%(playlist_title).200B"). Поэтому используем -o, который
        # переопределяет -o из yt-dlp.conf.
        # Префикс %(playlist_index)02d — порядковый номер с ведущим нулём
        # ("01 - название.mp3"). Это стандартная практика для альбомов
        # и заодно решает проблему коллизий имён (без id-в-скобках).
        # |Playlist — fallback если поле playlist_title пустое.
        if payload.get("subfolder", True):
            cmd += [
                "-o",
                "playlist/%(playlist_title|Playlist).200B/%(playlist_index)02d - %(title).200B.%(ext)s",
            ]
    elif mode == "channel":
        cmd += ["--yes-playlist"]
        cmd += playlist_range_args(payload.get("range", "10"))
        fmt = payload.get("format", "video")
        cmd += format_to_args(fmt)
        is_audio = fmt in ("mp3", "opus", "m4a")
        # Канал — список последних видео, нумерация бессмысленна
        # (видео могут добавляться/удаляться, порядок плавающий).
        # Поэтому только название, без префикса и без id.
        if payload.get("subfolder", True):
            cmd += [
                "-o",
                "channel/%(channel|Unknown).200B/%(title).200B.%(ext)s",
            ]

    cmd += container_args(container, is_audio)
    cmd += archive_args(use_archive)
    cmd += sleep_args(sleep)
    cmd.append(url)
    return cmd


def task_to_dict(t):
    return {
        "id": t["id"],
        "url": t["url"],
        "mode": t["mode"],
        "title": t["title"],
        "tab_title": t.get("tab_title"),
        "status": t["status"],
        "added_at": t["added_at"],
        "started_at": t.get("started_at"),
        "finished_at": t.get("finished_at"),
        "exit_code": t.get("exit_code"),
        "log_file": os.path.basename(t.get("log_file", "")) if t.get("log_file") else None,
        # Прогресс
        "progress": t.get("progress"),       # {"percent": 42.3, "filename": "...", "playlist_n": 3, "playlist_total": 10}
        "payload": t.get("payload"),         # для повторного запуска
    }


# === Парсер прогресса yt-dlp ===
# Примеры строк, которые парсим:
#   [download]   3.2% of  120.34MiB at  3.85MiB/s ETA 00:31
#   [download] 100% of  120.34MiB in 00:30
#   [download] Destination: videos\Some Title.f399.mp4
#   [download] Downloading item 3 of 25
#   [Merger] Merging formats into "videos\Some Title.mkv"
RE_PERCENT = re.compile(r"\[download\]\s+([\d.]+)%")
RE_DESTINATION = re.compile(r"\[download\]\s+Destination:\s+(.+?)\s*$")
RE_PLAYLIST_ITEM = re.compile(r"\[download\]\s+Downloading item (\d+) of (\d+)")
# yt-dlp иногда пишет так на новых версиях:
RE_PLAYLIST_VIDEO = re.compile(r"\[download\]\s+Downloading video (\d+) of (\d+)")
RE_MERGER = re.compile(r"\[Merger\]\s+Merging formats into\s+\"?([^\"]+)\"?")


def parse_progress_line(line, current_progress):
    """Обновляет dict прогресса на основе строки stdout yt-dlp."""
    # Сначала проверяем пакетные счётчики (плейлист) — они не обнуляют percent
    m = RE_PLAYLIST_ITEM.search(line) or RE_PLAYLIST_VIDEO.search(line)
    if m:
        current_progress["playlist_n"] = int(m.group(1))
        current_progress["playlist_total"] = int(m.group(2))
        # Новый файл начался — обнуляем процент
        current_progress["percent"] = 0.0
        return

    # Имя файла (Destination)
    m = RE_DESTINATION.search(line)
    if m:
        path = m.group(1).strip()
        # Берём только имя файла без папки (работает для обоих типов слешей)
        name = path.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
        # Срезаем .fXXX перед расширением (промежуточные форматы)
        name = re.sub(r"\.f\d+(?=\.[^.]+$)", "", name)
        current_progress["filename"] = name
        current_progress["percent"] = 0.0
        return

    # Merger — финальное имя после склейки
    m = RE_MERGER.search(line)
    if m:
        # basename не работает с обратными слешами на Linux; берём вручную
        path = m.group(1).strip()
        name = path.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
        current_progress["filename"] = name
        return

    # Процент
    m = RE_PERCENT.search(line)
    if m:
        try:
            current_progress["percent"] = float(m.group(1))
        except ValueError:
            pass


# === Воркер ===
def worker_loop():
    global _current
    while True:
        task = _task_queue.get()
        if task is None:
            break

        with _state_lock:
            if task["status"] == "cancelled":
                _pending[:] = [p for p in _pending if p["id"] != task["id"]]
                _finished.append(task)
                if len(_finished) > KEEP_FINISHED:
                    _finished[:] = _finished[-KEEP_FINISHED:]
                continue
            _pending[:] = [p for p in _pending if p["id"] != task["id"]]
            task["status"] = "running"
            task["started_at"] = time.time()
            task["progress"] = {"percent": 0.0, "filename": None, "playlist_n": None, "playlist_total": None}
            _current = task

        log_path = os.path.join(LOGS_DIR, f"{task['id']:04d}.log")
        task["log_file"] = log_path

        cmd = build_command(task["payload"])
        print(f"\n[+] #{task['id']} START")
        print(f"    cmd: {' '.join(cmd)}")

        rc = -1
        try:
            # Открываем лог в текстовом UTF-8 режиме с буферизацией строк
            logf = open(log_path, "w", encoding="utf-8", buffering=1, newline="")
            try:
                logf.write(f"# {task['title']}\n# {task['url']}\n# cmd: {' '.join(cmd)}\n\n")

                env = os.environ.copy()
                env["PYTHONIOENCODING"] = "utf-8"

                proc = subprocess.Popen(
                    cmd,
                    cwd=YT_DLP_DIR,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    env=env,
                    bufsize=1,            # построчная буферизация
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                )
                task["pid"] = proc.pid

                # Поток для чтения stdout построчно: пишет в лог с метками
                # и обновляет прогресс задачи.
                def reader():
                    try:
                        for line in proc.stdout:
                            line = line.rstrip("\r\n")
                            if not line:
                                continue
                            ts = time.strftime("[%H:%M:%S]")
                            try:
                                logf.write(f"{ts} {line}\n")
                            except Exception:
                                pass
                            with _state_lock:
                                if task.get("progress") is not None:
                                    parse_progress_line(line, task["progress"])
                    except Exception as e:
                        try:
                            logf.write(f"# reader error: {e}\n")
                        except Exception:
                            pass

                rt = threading.Thread(target=reader, daemon=True)
                rt.start()

                # Ждём процесс с проверкой флага отмены
                while True:
                    try:
                        rc = proc.wait(timeout=0.5)
                        break
                    except subprocess.TimeoutExpired:
                        if _cancel_flag["id"] == task["id"]:
                            print(f"[!] #{task['id']} CANCELLING")
                            try:
                                proc.terminate()
                                try:
                                    rc = proc.wait(timeout=3)
                                except subprocess.TimeoutExpired:
                                    proc.kill()
                                    rc = proc.wait()
                            except Exception as e:
                                print(f"[!] cancel error: {e}")
                            break

                rt.join(timeout=2)
            finally:
                try:
                    logf.close()
                except Exception:
                    pass

        except FileNotFoundError:
            print(f"[X] #{task['id']} ERROR: yt-dlp.exe не найден ({YT_DLP_EXE})")
            rc = -2
        except Exception as e:
            print(f"[X] #{task['id']} ERROR: {e}")
            rc = -3

        with _state_lock:
            task["finished_at"] = time.time()
            task["exit_code"] = rc
            if _cancel_flag["id"] == task["id"]:
                task["status"] = "cancelled"
                _cancel_flag["id"] = None
            elif rc == 0:
                task["status"] = "done"
            else:
                task["status"] = f"error ({rc})"

            _finished.append(task)
            if len(_finished) > KEEP_FINISHED:
                _finished[:] = _finished[-KEEP_FINISHED:]
            _current = None

        # После любого завершения update-задачи сбрасываем кэш версии,
        # чтобы следующий /version перечитал её из обновлённого бинарника.
        if task.get("mode") == "update":
            with _version_lock:
                _version_cache["mtime"] = None
                _version_cache["version"] = None

        print(f"[=] #{task['id']} {task['status']}")


# === HTTP ===
class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/ping":
            self._send_json(200, {"ok": True, "version": "2.6"})
            return

        if path == "/version":
            v = get_yt_dlp_version()
            self._send_json(200, {"version": v, "exe": YT_DLP_EXE, "exists": v is not None})
            return

        if path == "/queue":
            with _state_lock:
                resp = {
                    "current": task_to_dict(_current) if _current else None,
                    "pending": [task_to_dict(t) for t in _pending],
                    "finished": [task_to_dict(t) for t in reversed(_finished)],
                }
            self._send_json(200, resp)
            return

        if path == "/settings":
            with _settings_lock:
                self._send_json(200, dict(_settings))
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception as e:
            self._send_json(400, {"error": f"bad json: {e}"})
            return

        if path == "/download":
            url = payload.get("url", "").strip()
            if not url:
                self._send_json(400, {"error": "url is required"})
                return
            if not url.startswith(("http://", "https://")):
                self._send_json(400, {"error": "url must start with http(s)://"})
                return

            # tab_title — заголовок вкладки браузера. Шлёт попап чтобы в
            # очереди сразу было видно что качается, не дожидаясь yt-dlp.
            # Обрезаем до разумных 200 символов, на всякий случай.
            tab_title = payload.get("tab_title")
            if isinstance(tab_title, str):
                tab_title = tab_title.strip()[:200] or None
            else:
                tab_title = None

            with _state_lock:
                _next_id[0] += 1
                tid = _next_id[0]
                task = {
                    "id": tid,
                    "url": url,
                    "mode": payload.get("mode", "video"),
                    "title": short_title(payload),
                    "tab_title": tab_title,
                    "status": "pending",
                    "added_at": time.time(),
                    "payload": payload,
                }
                _pending.append(task)
            _task_queue.put(task)
            print(f"[Q] #{tid} queued: {task['title']} {url}")
            self._send_json(200, {"ok": True, "id": tid, "queued": True})
            return

        if path == "/update":
            # Не пускаем второе обновление если первое ещё в очереди или
            # выполняется. Скачивания не блокируем — они подождут в очереди
            # своей очереди как обычно.
            with _state_lock:
                already = (
                    (_current and _current.get("mode") == "update")
                    or any(t.get("mode") == "update" for t in _pending)
                )
                if already:
                    self._send_json(409, {"error": "обновление уже в очереди"})
                    return
                _next_id[0] += 1
                tid = _next_id[0]
                upd_payload = {"mode": "update"}
                task = {
                    "id": tid,
                    "url": "",
                    "mode": "update",
                    "title": short_title(upd_payload),
                    "status": "pending",
                    "added_at": time.time(),
                    "payload": upd_payload,
                }
                _pending.append(task)
            _task_queue.put(task)
            print(f"[Q] #{tid} queued: yt-dlp -U")
            self._send_json(200, {"ok": True, "id": tid, "queued": True})
            return

        if path == "/cancel":
            tid = payload.get("id")
            if not isinstance(tid, int):
                self._send_json(400, {"error": "id (int) required"})
                return
            with _state_lock:
                for t in _pending:
                    if t["id"] == tid:
                        t["status"] = "cancelled"
                        t["finished_at"] = time.time()
                        self._send_json(200, {"ok": True, "where": "pending"})
                        return
                if _current and _current["id"] == tid:
                    _cancel_flag["id"] = tid
                    self._send_json(200, {"ok": True, "where": "current"})
                    return
            self._send_json(404, {"error": "task not found or already finished"})
            return

        if path == "/cancel-all":
            # Отменяем все pending задачи. Текущую не трогаем — её можно
            # отменить отдельной кнопкой ✕. Воркер сам перенесёт отменённые
            # задачи из _pending в _finished когда дойдёт до них в очереди
            # (он умеет пропускать cancelled — см. worker_loop).
            cancelled = 0
            with _state_lock:
                for t in _pending:
                    if t["status"] == "pending":
                        t["status"] = "cancelled"
                        t["finished_at"] = time.time()
                        cancelled += 1
            self._send_json(200, {"ok": True, "cancelled": cancelled})
            return

        if path == "/restart":
            # Повторить ранее завершённую задачу: ищем её payload в _finished.
            tid = payload.get("id")
            if not isinstance(tid, int):
                self._send_json(400, {"error": "id (int) required"})
                return
            with _state_lock:
                src = next((t for t in _finished if t["id"] == tid), None)
                if not src:
                    self._send_json(404, {"error": "task not found in history"})
                    return
                _next_id[0] += 1
                new_id = _next_id[0]
                new_task = {
                    "id": new_id,
                    "url": src["url"],
                    "mode": src["mode"],
                    "title": src["title"],
                    "tab_title": src.get("tab_title"),
                    "status": "pending",
                    "added_at": time.time(),
                    "payload": src.get("payload") or {"url": src["url"], "mode": src["mode"]},
                }
                _pending.append(new_task)
            _task_queue.put(new_task)
            print(f"[Q] #{new_id} restart of #{tid}")
            self._send_json(200, {"ok": True, "id": new_id, "queued": True})
            return

        if path == "/clear-finished":
            # Очистить историю завершённых задач (то, что показывается
            # в попапе под "Последние"). Не трогает ничего активного.
            with _state_lock:
                cleared = len(_finished)
                _finished.clear()
            print(f"[clear] cleared {cleared} finished tasks")
            self._send_json(200, {"ok": True, "cleared": cleared})
            return

        if path == "/settings":
            # Принимаем только известные ключи, проверяем значения.
            allowed = {
                "use_archive": (bool,),
                "container": ("mp4", "mkv", "both"),
                "audio_format": ("mp3", "opus", "m4a", "wav"),
                "audio_quality": (str,),
                "video_quality": ("best", "2160", "1440", "1080", "720", "480"),
            }
            updates = {}
            for k, rule in allowed.items():
                if k in payload:
                    v = payload[k]
                    if rule == (bool,):
                        if isinstance(v, bool):
                            updates[k] = v
                    elif rule == (str,):
                        if isinstance(v, str):
                            updates[k] = v
                    else:
                        if v in rule:
                            updates[k] = v

            # sleep отдельной логикой — может быть строкой или числом.
            # Допустимое: "config", "none", int >= 0, str(int).
            if "sleep" in payload:
                v = payload["sleep"]
                if v in ("config", "none"):
                    updates["sleep"] = v
                else:
                    try:
                        n = int(v)
                        if n >= 0:
                            updates["sleep"] = n
                    except (TypeError, ValueError):
                        pass

            with _settings_lock:
                _settings.update(updates)
                snapshot = dict(_settings)
            save_settings()
            self._send_json(200, snapshot)
            return

        self._send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        # Тише, чтобы лог сервера не засорялся опросами от попапа
        msg = fmt % args
        if any(p in msg for p in ("/queue", "/ping", "/settings", "/version")):
            return
        sys.stderr.write(f"[server] {msg}\n")


def init_logs_dir():
    """
    Готовит папку logs/ при старте сервера:
      1) удаляет лог-файлы старше LOG_RETENTION_DAYS дней (хлам не копится);
      2) сканирует оставшиеся файлы вида NNNN.log и возвращает максимальный
         номер. Это нужно чтобы _next_id стартовал с (max + 1) и не затирал
         существующие логи после рестарта сервера.
    """
    os.makedirs(LOGS_DIR, exist_ok=True)
    now = time.time()
    cutoff = now - LOG_RETENTION_DAYS * 86400
    deleted = 0
    max_id = 0

    try:
        entries = os.listdir(LOGS_DIR)
    except OSError as e:
        print(f"[logs] не могу прочитать {LOGS_DIR}: {e}")
        return 0

    for name in entries:
        path = os.path.join(LOGS_DIR, name)
        if not os.path.isfile(path):
            continue
        # Удаляем старые .log файлы
        try:
            mtime = os.path.getmtime(path)
            if name.endswith(".log") and mtime < cutoff:
                os.remove(path)
                deleted += 1
                continue
        except OSError:
            pass
        # Ищем максимальный номер среди оставшихся NNNN.log
        m = re.match(r"^(\d{1,6})\.log$", name)
        if m:
            n = int(m.group(1))
            if n > max_id:
                max_id = n

    if deleted:
        print(f"[logs] удалено {deleted} старых логов (>{LOG_RETENTION_DAYS} дней)")
    if max_id:
        print(f"[logs] следующий id задачи: #{max_id + 1}")
    return max_id


def main():
    print("=" * 60)
    print(" yt-dlp local bridge v2.6 (queue + settings + progress + update + sleep + logs)")
    print("=" * 60)
    print(f" yt-dlp.exe : {YT_DLP_EXE}")
    print(f" logs       : {LOGS_DIR}")
    print(f" settings   : {SETTINGS_FILE}")
    print(f" Слушаю    : http://{HOST}:{PORT}")
    print(f" Закрыть   : Ctrl+C или просто закрой это окно")
    print("=" * 60)

    if not os.path.isfile(YT_DLP_EXE):
        print(f"\n[!] ВНИМАНИЕ: {YT_DLP_EXE} не найден.")
        print("    Поправь YT_DLP_DIR в начале server.py\n")

    # Cleanup старых логов + восстановление счётчика задач после рестарта.
    max_existing_id = init_logs_dir()
    _next_id[0] = max_existing_id

    load_settings()

    worker = threading.Thread(target=worker_loop, daemon=True, name="yt-dlp-worker")
    worker.start()

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] Остановка...")
        server.server_close()


if __name__ == "__main__":
    main()
