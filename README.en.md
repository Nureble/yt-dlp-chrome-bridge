# yt-dlp Chrome Bridge

> [Русская версия](README.md)

A bridge between a Chrome extension and a local Python server that wraps
[yt-dlp](https://github.com/yt-dlp/yt-dlp), letting you download media
directly from your browser. Auto-detects video / playlist / channel on
**YouTube, Twitter/X, Twitch, SoundCloud, Reddit, Instagram**, and works
with **1800+ other sites** via manual URL paste or context menu.

**Windows only.** Linux/macOS not tested.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **Extension popup** with queue, progress and history.
- **URL auto-detection** for video / playlist / channel on 6 supported sites.
- **Manual URL paste** for any other site supported by yt-dlp.
- **Context menu**: right-click a link or page → "Download via yt-dlp".
- **4 download modes**: video (with quality), audio (mp3/opus/m4a/wav),
  playlist (with range), channel (latest N).
- **Configurable sleep between downloads**: from yt-dlp.conf / no sleep /
  custom N seconds.
- **Single-worker queue** — one download at a time so your proxy doesn't
  get hammered. Cancel a task or the entire queue.
- **One-click yt-dlp self-update** from the extension settings.
- **Real-time progress**: filename, percentage, N/M for playlists.
- **Per-task logs** in `logs/NNNN.log` with timestamps. Old logs are
  auto-cleaned.
- **Global defaults** (container, sleep, format) with per-task override.

## Screenshots

![Plugin screenshot](https://i.imgur.com/GQYfZ2y.png)

## Requirements

- **Windows 10/11**
- **Python 3.8+** (standard library only, no pip packages)
- **yt-dlp.exe** — [download](https://github.com/yt-dlp/yt-dlp/releases/latest)
- **ffmpeg.exe + ffprobe.exe** — [download](https://www.gyan.dev/ffmpeg/builds/)
  (required for video+audio merging and conversion). Place them next to
  `yt-dlp.exe` or add the ffmpeg folder to your system PATH — yt-dlp finds
  it both ways.
- **deno.exe** — [download](https://github.com/denoland/deno/releases/latest)
  (archive `deno-x86_64-pc-windows-msvc.zip`, **not** `denort`). Starting
  with yt-dlp 2025.11.12 this is a **required** dependency for YouTube
  downloads — without deno, YouTube either returns crippled formats or
  refuses to download at all. Place `deno.exe` next to `yt-dlp.exe` or
  add it to PATH. Other sites (Twitter/X, Twitch, SoundCloud, etc.)
  don't need deno.
- **Google Chrome / Chromium** (Edge works too)

## Installation

### 1. Set up your yt-dlp folder

Create a folder somewhere (e.g. `D:\yt-dlp`) and put inside:

- `yt-dlp.exe`
- `ffmpeg.exe`, `ffprobe.exe`
- `deno.exe` (required for YouTube since yt-dlp 2025.11.12)
- `yt-dlp.conf` — your main yt-dlp config (proxy, cookies, output template,
  sleep, etc.)

Minimal `yt-dlp.conf` example:

```
-P "videos"
-P "audio:music"
--embed-metadata
--no-mtime
--sleep-interval 10
--max-sleep-interval 20
```

The extension layers its own per-task flags (quality, format, container)
on top of this config — you don't need to modify the config file itself.

#### Extended `yt-dlp.conf` example

This is the config I use myself. It works with a local Clash proxy on
default port 7897 (SOCKS5, system-wide) and uses Firefox cookies to
authenticate with YouTube (needed for age-restricted videos and private
playlists).

```
# coding: utf-8

# --- NETWORK & AUTH ---
--proxy "socks5://127.0.0.1:7897"
--cookies-from-browser firefox
--socket-timeout 60

# --- RATE LIMIT (for channels and playlists) ---
# Cap at 10 MB/s so we don't hammer the proxy
--limit-rate 10M
# Random pause between videos: 20 to 60 seconds (humans aren't robots)
--sleep-interval 20
--max-sleep-interval 60

# --- PATHS (relative) ---
-P "./videos"
-o "audio:./music/%(title)s.%(ext)s"
-o "%(title)s.%(ext)s"

# --- ARCHIVE ---
# Skip videos whose ID is already in this file
--download-archive "archive.txt"

# --- QUALITY ---
-S "res,fps"
--merge-output-format mkv

# --- DUAL OUTPUT (MKV + MP4) ---
--exec "after_move:if '%(ext)s'=='mkv' ffmpeg -y -i %(filepath)q -c copy \"%(filepath.0:-4)s.mp4\""

# --- EXTRAS ---
--embed-subs
--sub-langs "all,-live_chat"
--embed-metadata
--ignore-errors
```

> **Why Firefox specifically?** Chrome and Edge have started encrypting
> cookies (Application-Bound Encryption), which yt-dlp can't always read.
> Firefox is the most reliable option. If you only have Chrome, you have
> two choices: install Firefox just for one YouTube login (cookies-from-browser
> firefox keeps working even when Firefox is closed afterwards), or
> manually export cookies to a file and use `--cookies cookies.txt`
> instead of `--cookies-from-browser`.

### 2. Clone the repository

```bash
git clone https://github.com/Nureble/yt-dlp-chrome-bridge.git
cd yt-dlp-chrome-bridge
```

### 3. Configure the server

Copy the example config and edit it:

```bash
copy config.example.json config.json
```

Open `config.json` and point `yt_dlp_dir` to the folder containing `yt-dlp.exe`:

```json
{
  "yt_dlp_dir": "D:/yt-dlp",
  "host": "127.0.0.1",
  "port": 5000,
  "keep_finished": 30,
  "log_retention_days": 30
}
```

> **Note:** in `yt_dlp_dir` use forward slashes (`D:/yt-dlp`) or escaped
> backslashes (`D:\\yt-dlp`). Single backslashes break JSON parsing.

### 4. Start the server

Double-click `start-server.bat`. You should see:

```
============================================================
 yt-dlp local bridge v2.6 (queue + settings + progress + update + sleep + logs)
============================================================
 yt-dlp.exe : D:/yt-dlp/yt-dlp.exe
 logs       : D:/yt-dlp/logs
 settings   : D:/yt-dlp/yt-dlp-bridge-settings.json
 Listening  : http://127.0.0.1:5000
```

Keep this window open while using the extension. Closing it disables the
extension (but doesn't interrupt the active download).

### 5. Install the extension in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder from this repo

The extension icon appears in Chrome's toolbar. Pin it via the puzzle icon
if you want it always visible.

### 6. Verify

Open a YouTube video, click the extension icon. The popup should show a
green badge ("Server up") and the auto-detected video URL. Click "Download" —
the task appears in the queue.

## Usage

### Auto-detected sites

1. Open a video / playlist / channel page
2. Click the extension icon — URL and content type are detected automatically
3. Choose mode (video/audio/playlist/channel) and options
4. Click "Download"

### Other sites

1. Copy the media URL
2. Click the extension icon
3. Paste the URL, choose mode, click "Download"

Full supported-sites list: [yt-dlp/supportedsites.md](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).

### Right-click

On any supported site — right-click the page → "Download this page via
yt-dlp". Right-click a link → "Download via yt-dlp". Uses default settings
without opening the popup.

### Global settings

Extension icon → ⚙ (or `chrome://extensions/` → "Extension options"):

- Default video quality
- Default audio format and bitrate
- Container: MKV+MP4 / MP4 only / MKV only
- Whether to use `archive.txt` by default
- Sleep between downloads
- **One-click yt-dlp update**

## Where files go

Depends on your `yt-dlp.conf`. With the minimal example above:

- Video: `<yt_dlp_dir>/videos/`
- Audio: `<yt_dlp_dir>/music/`
- Playlist: `<yt_dlp_dir>/videos/playlist/<name>/01 - track.mp3`
- Channel: `<yt_dlp_dir>/videos/channel/<channel_name>/title.mkv`

> **Note about `-o` in your `yt-dlp.conf`.** For Playlist and Channel
> modes, the extension adds its own `-o` template that **overrides** the
> one in your config. This is needed to create the per-playlist/per-channel
> subfolder and to number tracks. Your config's `-o` template still applies
> to single video and audio downloads.

## Troubleshooting

### Setup issues

**`'python' is not recognized as an internal or external command`.** During
Python installation you didn't check the "Add python.exe to PATH" box.
Reinstall Python from [python.org](https://www.python.org/downloads/) —
on the first installer screen tick **"Add python.exe to PATH"**.

**Server crashes immediately with `[!] FATAL: yt_dlp_dir = ... — папка не существует`.**
The path in `config.json` points to a missing folder. Create it or fix
the path (forward slashes `D:/yt-dlp` or escaped backslashes `D:\\yt-dlp`).

**`[!] FATAL: ни config.json, ни config.example.json не найдены`.** You're
running `start-server.bat` from outside the repo folder. Double-clicking
the bat only works if it sits next to `server.py`.

**On first run: `[!] ОТКРОЙ config.json И УКАЖИ СВОЙ yt_dlp_dir`.** This
is normal — the server just copied the example config for you. Open
`config.json`, edit the path, restart `start-server.bat`.

### Runtime issues

**Popup says "Server not responding".** Start `start-server.bat`. If running,
check the server console for errors and verify port 5000 is free.

**Extension works but downloads fail with `yt-dlp.exe not found`.** Verify
that `config.json` has the correct path and that `yt-dlp.exe` actually
exists in that folder.

**Buttons don't work on a YouTube page.** Reload the tab (F5). If still
broken — `chrome://extensions/` → reload icon next to the extension.

**Filenames show `?????` instead of Cyrillic/Asian characters.** Update
yt-dlp (extension settings → "Update"). The server already passes
`--encoding utf-8` but older yt-dlp versions may have ignored it.

**Queue stuck, won't proceed.** ffmpeg got stuck on an interactive prompt.
Kill `ffmpeg.exe` and `yt-dlp.exe` in Task Manager. Add `-y` to any `--exec`
ffmpeg calls in your `yt-dlp.conf` so it overwrites silently.

**Where are task logs?** In `<yt_dlp_dir>/logs/NNNN.log` — full yt-dlp
output with timestamps for each task.

**Log shows `No supported JavaScript runtime could be found` when
downloading from YouTube.** No `deno.exe` in `yt_dlp_dir` or it's too old.
Download a fresh one from
[github.com/denoland/deno/releases](https://github.com/denoland/deno/releases/latest)
(archive `deno-x86_64-pc-windows-msvc.zip`, not `denort`!), extract
`deno.exe` into your yt-dlp folder.

**Log shows `Some web client https formats have been skipped` or
`YouTube is forcing SABR streaming for this client`.** Same symptom —
yt-dlp can't solve YouTube's JS challenge. Install deno (see above) or
update yt-dlp (extension settings → "Update").

**YouTube downloads are very slow (50–100 KiB/s).** YouTube throttles
bots. Without deno or with an outdated yt-dlp, speed drops to a crawl.
Fix: install deno and update yt-dlp.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) (Russian only for now).

## License

[MIT](LICENSE) © Nureble

## Acknowledgements

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — none of this works without it.