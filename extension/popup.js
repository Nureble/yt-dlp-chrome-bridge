const SERVER = (globalThis.YTDLP_BRIDGE_CONFIG && globalThis.YTDLP_BRIDGE_CONFIG.SERVER_URL) || "http://127.0.0.1:5000";

// === Helpers ===
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "onclick") e.addEventListener("click", v);
    else if (k === "title") e.title = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин ${Math.round(seconds % 60)} с`;
  return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname.slice(0, 30);
  } catch {
    return url.slice(0, 50);
  }
}

// === Запросы к background ===
function classifyUrl(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "classify", url }, (resp) => resolve(resp || null));
  });
}

// === DOM elements ===
const $serverStatus = document.getElementById("server-status");
const $dlSection = document.getElementById("dl-section");
const $dlContext = document.getElementById("dl-context");
const $dlUrl = document.getElementById("dl-url");
const $dlGo = document.getElementById("dl-go");
const $dlStatus = document.getElementById("dl-status");

const $currentSection = document.getElementById("current-section");
const $currentTask = document.getElementById("current-task");
const $pendingSection = document.getElementById("pending-section");
const $pendingCount = document.getElementById("pending-count");
const $pendingList = document.getElementById("pending-list");
const $finishedSection = document.getElementById("finished-section");
const $finishedList = document.getElementById("finished-list");
const $serverDownState = document.getElementById("server-down-state");

// === Активная вкладка для скачивания ===
let activeContext = null; // { kind, url, site } или null
let activeTabTitle = null; // заголовок вкладки браузера (для UI очереди)

// === Переключение вкладок режима ===
function setActiveTab(tabId) {
  document.querySelectorAll(".dl-tab").forEach((t) => {
    t.classList.toggle("dl-tab-active", t.dataset.tab === tabId);
  });
  document.querySelectorAll(".dl-pane").forEach((p) => {
    p.classList.toggle("dl-hidden", p.dataset.pane !== tabId);
  });
}

document.querySelectorAll(".dl-tab").forEach((t) => {
  t.addEventListener("click", () => setActiveTab(t.dataset.tab));
});

// MP3 quality виден только при выборе MP3
const $aformat = document.getElementById("dl-aformat");
const $aqLabel = document.getElementById("dl-aq-label");
const $aquality = document.getElementById("dl-aquality");
function updateAQ() {
  const isMp3 = $aformat.value === "mp3";
  $aqLabel.style.display = isMp3 ? "" : "none";
  $aquality.style.display = isMp3 ? "" : "none";
}
$aformat.addEventListener("change", updateAQ);
updateAQ();

// Custom range fields
const $plRange = document.getElementById("dl-pl-range");
const $plCustom = document.getElementById("dl-pl-custom");
$plRange.addEventListener("change", () => {
  $plCustom.classList.toggle("dl-hidden", $plRange.value !== "custom");
});
const $chRange = document.getElementById("dl-ch-range");
const $chCustom = document.getElementById("dl-ch-custom");
$chRange.addEventListener("change", () => {
  $chCustom.classList.toggle("dl-hidden", $chRange.value !== "custom");
});

// === Селектор пауз ===
// "config" → ничего не передаём, работают значения из yt-dlp.conf
// "none"   → передаём 0 секунд во все три флага паузы
// "custom" → показываем поле для ввода секунд, передаём это число
const $sleep = document.getElementById("dl-sleep");
const $sleepCustom = document.getElementById("dl-sleep-custom");
const $sleepWarn = document.getElementById("dl-sleep-warn");

function updateSleepUi() {
  const v = $sleep.value;
  $sleepCustom.classList.toggle("dl-hidden", v !== "custom");
  // Предупреждение показываем только если выбраны "без пауз" или 0/маленькое
  // число секунд И контекст ютубовский. На остальных сайтах паузы не критичны.
  const isYoutube = activeContext && activeContext.site === "youtube";
  let dangerous = false;
  if (v === "none") dangerous = true;
  else if (v === "custom") {
    const n = parseInt($sleepCustom.value, 10);
    if (!isNaN(n) && n < 3) dangerous = true;
  }
  $sleepWarn.classList.toggle("dl-hidden", !(dangerous && isYoutube));
}
$sleep.addEventListener("change", updateSleepUi);
$sleepCustom.addEventListener("input", updateSleepUi);

// === Подгружаем дефолты настроек с сервера ===
async function loadServerDefaults() {
  try {
    const res = await fetch(`${SERVER}/settings`);
    if (!res.ok) return;
    const s = await res.json();
    document.getElementById("dl-container").value = s.container || "both";
    document.getElementById("dl-use-archive").checked = s.use_archive !== false;
    if (s.video_quality) document.getElementById("dl-quality").value = s.video_quality;
    if (s.audio_format) $aformat.value = s.audio_format;
    if (s.audio_quality) $aquality.value = s.audio_quality;
    // sleep: "config" | "none" | число (любое > 0 → custom + поле заполнено)
    if (s.sleep === "config" || s.sleep === "none") {
      $sleep.value = s.sleep;
    } else if (typeof s.sleep === "number" && s.sleep >= 0) {
      $sleep.value = "custom";
      $sleepCustom.value = String(s.sleep);
    }
    updateAQ();
    updateSleepUi();
  } catch {
    // сервер не отвечает — остаются UI-дефолты
  }
}

// === Получаем URL и заголовок текущей вкладки ===
async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

// Вытаскиваем чистое название медиа из заголовка вкладки.
// Заголовки вкладок выглядят примерно так:
//   "Название - YouTube"
//   "(N) Название - YouTube"  (N — счётчик уведомлений)
//   "Название | Альбом | Артист на SoundCloud — Listen for free"
//   "Имя на X: «текст»"
//   "Username on Twitch"
// Срезаем хвосты что увидим, остальное оставляем как есть.
function cleanTitle(rawTitle) {
  if (!rawTitle) return "";
  let t = rawTitle.trim();
  // Счётчик уведомлений в начале: "(123) Название"
  t = t.replace(/^\(\d+\+?\)\s*/, "");
  // YouTube
  t = t.replace(/\s*[-–—]\s*YouTube\s*$/i, "");
  // SoundCloud
  t = t.replace(/\s*\|\s*Listen for free.*$/i, "");
  t = t.replace(/\s+на\s+SoundCloud.*$/i, "");
  // Twitch
  t = t.replace(/\s*-\s*Twitch\s*$/i, "");
  // Twitter / X
  t = t.replace(/\s+on\s+X(:|\s.*)?$/i, "");
  // Reddit, Instagram и т.п. — обычно слишком вариативно, оставляем как есть
  return t.trim();
}

// === Инициализация контекста (что в активной вкладке) ===
async function initContext() {
  const tab = await getActiveTab();
  const tabUrl = tab?.url || null;
  const tabTitle = cleanTitle(tab?.title);
  activeTabTitle = tabTitle || null;
  const cls = await classifyUrl(tabUrl);

  if (cls) {
    activeContext = cls;
    let icon = "🎬";
    let label = "видео";
    let defaultTab = "video";
    if (cls.kind === "playlist") {
      icon = "📃";
      label = "плейлист";
      defaultTab = "playlist";
    } else if (cls.kind === "channel") {
      icon = "📺";
      label = "канал";
      defaultTab = "channel";
    }
    // Собираем блок: иконка + название + краткая ссылка
    const children = [
      el("div", { class: "ctx-row" }, [
        el("span", { class: "ctx-icon" }, icon),
        el("span", { class: "ctx-kind" }, label),
      ]),
    ];
    if (tabTitle) {
      children.push(el("div", { class: "ctx-title", title: tabTitle }, tabTitle));
    }
    children.push(
      el("div", { class: "ctx-url", title: cls.url }, shortUrl(cls.url))
    );
    $dlContext.replaceChildren(el("div", { class: "ctx-good" }, children));
    $dlUrl.value = "";
    $dlUrl.placeholder = "Или вставь другую ссылку…";
    setActiveTab(defaultTab);
    updateSleepUi();
  } else {
    activeContext = null;
    $dlContext.replaceChildren(
      el("div", { class: "ctx-empty" }, [
        el("span", { class: "ctx-icon" }, "ℹ️"),
        el("span", {}, "Вставь ссылку для скачивания (YouTube, Twitter/X, Twitch, SoundCloud, Vimeo и др.):"),
      ])
    );
    $dlUrl.placeholder = "https://...";
    $dlUrl.focus();
  }
}

// При вводе URL вручную — переклассифицируем и подсвечиваем нужную вкладку
$dlUrl.addEventListener("input", async () => {
  const v = $dlUrl.value.trim();
  if (!v) return;
  const cls = await classifyUrl(v);
  if (cls) {
    activeContext = { ...cls, manual: true };
    if (cls.kind === "playlist") setActiveTab("playlist");
    else if (cls.kind === "channel") setActiveTab("channel");
    else setActiveTab("video");
    updateSleepUi();
  }
});

// === Кнопка "Скачать" ===
$dlGo.addEventListener("click", async () => {
  // Какой URL? Если пользователь что-то вписал — приоритет ему.
  const manualUrl = $dlUrl.value.trim();
  let url = manualUrl;

  if (!url) {
    if (!activeContext) {
      $dlStatus.textContent = "Вставь ссылку";
      $dlStatus.className = "dl-status dl-status-err";
      return;
    }
    url = activeContext.url;
  }

  // Минимальная валидация. Дальше yt-dlp сам разбирается какому
  // экстрактору отдать URL — он умеет тысячи сайтов.
  if (!/^https?:\/\//i.test(url)) {
    $dlStatus.textContent = "Ссылка должна начинаться с http:// или https://";
    $dlStatus.className = "dl-status dl-status-err";
    return;
  }

  // Если введён ручной ютубовский URL — нормализуем (classify возвращает
  // канонический /watch?v=...). Для не-ютуба classify даст null — и это ок,
  // отправляем как есть.
  if (manualUrl) {
    const cls = await classifyUrl(manualUrl);
    if (cls) url = cls.url;
  }

  // Активная вкладка режима в попапе — она и определяет mode.
  // Для не-ютубовских ссылок пользователь сам выбирает что хочет
  // (видео/аудио/плейлист/канал), сервер передаст это yt-dlp.
  const activeTab = document.querySelector(".dl-tab-active").dataset.tab;

  const body = { url };
  body.container = document.getElementById("dl-container").value;
  body.use_archive = document.getElementById("dl-use-archive").checked;
  // Заголовок вкладки — для отображения в очереди до того как yt-dlp
  // извлечёт настоящие метаданные. Если ссылка введена вручную — заголовка
  // у нас нет (вкладка пользователя на чём-то другом), и это нормально.
  if (activeTabTitle && !manualUrl) {
    body.tab_title = activeTabTitle;
  }

  // sleep: "config" → не передаём, серверный дефолт сработает.
  // "none" → "none". "custom" + число → число.
  if ($sleep.value === "none") {
    body.sleep = "none";
  } else if ($sleep.value === "custom") {
    const n = parseInt($sleepCustom.value, 10);
    if (!isNaN(n) && n >= 0) body.sleep = n;
    // если поле пустое или некорректное — sleep не передаём
  }
  // "config" → ничего, сервер использует свой дефолт

  if (activeTab === "video") {
    body.mode = "video";
    body.quality = document.getElementById("dl-quality").value;
  } else if (activeTab === "audio") {
    body.mode = "audio";
    body.audio_format = $aformat.value;
    if ($aformat.value === "mp3") body.audio_quality = $aquality.value;
  } else if (activeTab === "playlist") {
    body.mode = "playlist";
    body.range = $plRange.value === "custom" ? $plCustom.value.trim() : $plRange.value;
    body.format = document.getElementById("dl-pl-mode").value;
    body.subfolder = document.getElementById("dl-pl-subfolder").checked;
  } else if (activeTab === "channel") {
    body.mode = "channel";
    body.range = $chRange.value === "custom" ? $chCustom.value.trim() : $chRange.value;
    body.format = document.getElementById("dl-ch-mode").value;
    body.subfolder = document.getElementById("dl-ch-subfolder").checked;
  }

  $dlStatus.textContent = "Отправляю…";
  $dlStatus.className = "dl-status dl-status-pending";

  try {
    const res = await fetch(`${SERVER}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      $dlStatus.textContent = `✓ В очереди (#${data.id})`;
      $dlStatus.className = "dl-status dl-status-ok";
      $dlUrl.value = "";
      refresh();
    } else {
      $dlStatus.textContent = `✗ ${data.error || "ошибка"}`;
      $dlStatus.className = "dl-status dl-status-err";
    }
  } catch {
    $dlStatus.textContent = "✗ Сервер не отвечает";
    $dlStatus.className = "dl-status dl-status-err";
  }
});

// === Кнопка "Настройки" ===
document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// === Очередь ===
function statusBadge(status) {
  if (status === "running") return el("span", { class: "task-status status-running" }, "качается");
  if (status === "pending") return el("span", { class: "task-status status-pending" }, "ждёт");
  if (status === "done") return el("span", { class: "task-status status-done" }, "✓ готово");
  if (status === "cancelled") return el("span", { class: "task-status status-cancelled" }, "отменено");
  if (status && status.startsWith("error")) return el("span", { class: "task-status status-error" }, "✗ ошибка");
  return el("span", { class: "task-status status-pending" }, status || "?");
}

function progressBlock(progress) {
  if (!progress) return null;
  const { percent = 0, filename, playlist_n, playlist_total } = progress;
  const parts = [];
  if (filename || playlist_total) {
    let label = filename || "...";
    if (playlist_total && playlist_n) label = `[${playlist_n}/${playlist_total}] ${label}`;
    parts.push(el("div", { class: "progress-label", title: label }, label));
  }
  const barFill = el("div", { class: "progress-bar-fill" });
  barFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const bar = el("div", { class: "progress-bar" }, [barFill]);
  const pct = el("div", { class: "progress-pct" }, `${percent.toFixed(1)}%`);
  parts.push(el("div", { class: "progress-row" }, [bar, pct]));
  return el("div", { class: "progress" }, parts);
}

function taskNode(t, opts = {}) {
  const { showCancel = false, showRestart = false } = opts;
  const titleRow = el("div", { class: "task-title" }, [
    el("span", { class: "task-id" }, "#" + t.id),
    t.title || t.mode || "?",
  ]);
  const infoChildren = [titleRow];
  // tab_title — заголовок вкладки браузера, прислан попапом при создании
  // задачи. Если есть — показываем под бейджом режима, чтобы было ясно
  // что именно качается, не дожидаясь имени файла из yt-dlp.
  if (t.tab_title) {
    infoChildren.push(
      el("div", { class: "task-tab-title", title: t.tab_title }, t.tab_title)
    );
  }
  infoChildren.push(el("div", { class: "task-url", title: t.url }, shortUrl(t.url)));
  infoChildren.push(progressBlock(t.progress));
  const info = el("div", { class: "task-info" }, infoChildren);
  const right = [statusBadge(t.status)];
  if ((t.status === "done" || (t.status && t.status.startsWith("error"))) && t.started_at && t.finished_at) {
    right.push(el("span", { class: "duration" }, fmtDuration(t.finished_at - t.started_at)));
  }
  if (showCancel) {
    right.push(el("button", { class: "icon-btn cancel-btn", onclick: () => cancelTask(t.id), title: "Отменить" }, "✕"));
  }
  if (showRestart) {
    right.push(el("button", { class: "icon-btn restart-btn", onclick: () => restartTask(t.id), title: "Повторить" }, "↻"));
  }
  return el("div", { class: "task" }, [info, ...right]);
}

async function cancelTask(id) {
  try {
    await fetch(`${SERVER}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    refresh();
  } catch (e) {}
}

async function restartTask(id) {
  try {
    await fetch(`${SERVER}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    refresh();
  } catch (e) {}
}

async function refresh() {
  let q;
  try {
    const res = await fetch(`${SERVER}/queue`);
    if (!res.ok) throw new Error("bad status");
    q = await res.json();
  } catch (e) {
    $serverStatus.textContent = "✗";
    $serverStatus.className = "server-status server-down";
    $serverStatus.title = "сервер не отвечает";
    document.querySelectorAll(".section").forEach((s) => {
      if (s.id !== "dl-section") s.style.display = "none";
    });
    $serverDownState.style.display = "block";
    return;
  }

  $serverStatus.textContent = "✓";
  $serverStatus.className = "server-status server-up";
  $serverStatus.title = "сервер работает";
  $serverDownState.style.display = "none";

  if (q.current) {
    $currentSection.style.display = "block";
    $currentTask.replaceChildren(taskNode(q.current, { showCancel: true }));
  } else {
    $currentSection.style.display = "none";
  }

  if (q.pending && q.pending.length) {
    $pendingSection.style.display = "block";
    $pendingCount.textContent = q.pending.length;
    $pendingList.replaceChildren(...q.pending.map((t) => taskNode(t, { showCancel: true })));
  } else {
    $pendingSection.style.display = "none";
  }

  if (q.finished && q.finished.length) {
    $finishedSection.style.display = "block";
    $finishedList.replaceChildren(
      ...q.finished.map((t) => {
        const isFailed = (t.status && t.status.startsWith("error")) || t.status === "cancelled";
        return taskNode(t, { showRestart: isFailed });
      })
    );
  } else {
    $finishedSection.style.display = "none";
  }
}

document.getElementById("recheck").addEventListener("click", refresh);

document.getElementById("clear-finished").addEventListener("click", async () => {
  try {
    await fetch(`${SERVER}/clear-finished`, { method: "POST" });
    refresh();
  } catch (e) {}
});

document.getElementById("cancel-all").addEventListener("click", async () => {
  // Отмена всех pending. Текущую задачу не трогаем — она останется идти,
  // её можно отменить отдельной кнопкой ✕. Без подтверждения, потому что
  // отмена нерасходный шаг (ничего не качается ещё).
  try {
    await fetch(`${SERVER}/cancel-all`, { method: "POST" });
    refresh();
  } catch (e) {}
});

// Инициализация
(async () => {
  await Promise.all([initContext(), loadServerDefaults()]);
  // initContext проставляет activeContext.site — это нужно warning'у
  // про "без пауз на ютубе".
  updateSleepUi();
  refresh();
})();

const interval = setInterval(refresh, 1500);
window.addEventListener("unload", () => clearInterval(interval));
