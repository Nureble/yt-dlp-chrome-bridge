// background.js — service worker. Отвечает за:
//   - классификацию URL (что это — видео/плейлист/канал, на каком сайте);
//   - контекстное меню (правый клик на ссылку или странице).
//
// Поддерживаемые сайты (для авто-определения и контекстного меню):
//   YouTube, Twitter/X, Twitch, SoundCloud, Reddit, Instagram.
// Это НЕ ограничение скачивания — yt-dlp на сервере умеет 1800+ сайтов.

// MV3 service worker — config.js подключаем через importScripts.
// Он кладёт глобал YTDLP_BRIDGE_CONFIG, который читается ниже в `const SERVER`.
try { importScripts("config.js"); } catch (e) { /* config.js обязателен, без него работают дефолты */ }

const SERVER = (globalThis.YTDLP_BRIDGE_CONFIG && globalThis.YTDLP_BRIDGE_CONFIG.SERVER_URL) || "http://127.0.0.1:5000";

// Нормализация хоста: убираем www., m., mobile.
function normHost(hostname) {
  return hostname.replace(/^(www\.|m\.|mobile\.)/, "");
}

// Маленькие хелперы — каждый возвращает {kind, site, url} или null.
// kind: "video" | "playlist" | "channel"
// site: для отображения в попапе

function classifyYouTube(host, u) {
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    if (id) return { kind: "video", site: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
    return null;
  }
  if (host !== "youtube.com") return null;

  const path = u.pathname;
  const params = u.searchParams;

  if (path === "/watch" && params.get("v")) {
    return { kind: "video", site: "youtube", url: `https://www.youtube.com/watch?v=${params.get("v")}` };
  }
  if (path.startsWith("/live/")) {
    const id = path.split("/")[2];
    if (id) return { kind: "video", site: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (path.startsWith("/shorts/")) {
    const id = path.split("/")[2];
    if (id) return { kind: "video", site: "youtube", url: `https://www.youtube.com/shorts/${id}` };
  }
  if (path === "/playlist" && params.get("list")) {
    return { kind: "playlist", site: "youtube", url: u.toString() };
  }
  if (/^\/@[^/]+/.test(path) || path.startsWith("/channel/") || path.startsWith("/c/") || path.startsWith("/user/")) {
    let chUrl = u.origin + path.replace(/\/$/, "");
    if (!/\/videos$|\/streams$|\/shorts$/.test(chUrl)) {
      chUrl = chUrl.replace(/(\/@[^/]+|\/channel\/[^/]+|\/c\/[^/]+|\/user\/[^/]+)(\/.*)?$/, "$1/videos");
    }
    return { kind: "channel", site: "youtube", url: chUrl };
  }
  return null;
}

function classifyTwitter(host, u) {
  // twitter.com и x.com — одно и то же. Нормализуем на x.com.
  if (host !== "twitter.com" && host !== "x.com") return null;
  const path = u.pathname;
  // Видео-пост: /<user>/status/<id>
  const mStatus = path.match(/^\/[^/]+\/status\/(\d+)/);
  if (mStatus) {
    return { kind: "video", site: "twitter", url: `https://x.com${path}` };
  }
  // Профиль пользователя: /<user> или /<user>/media
  const mUser = path.match(/^\/([A-Za-z0-9_]{1,15})\/?(media\/?)?$/);
  if (mUser && !["home", "explore", "notifications", "messages", "i", "settings", "search"].includes(mUser[1])) {
    return { kind: "channel", site: "twitter", url: `https://x.com/${mUser[1]}` };
  }
  return null;
}

function classifyTwitch(host, u) {
  if (host !== "twitch.tv") return null;
  const path = u.pathname;
  // Клип: /<channel>/clip/<slug>
  if (/^\/[^/]+\/clip\/[^/?]+/.test(path)) {
    return { kind: "video", site: "twitch", url: u.origin + path };
  }
  // VOD: /videos/<id>
  if (/^\/videos\/\d+/.test(path)) {
    return { kind: "video", site: "twitch", url: u.origin + path };
  }
  // Стрим / профиль канала: /<channel> → даём ссылку на /videos
  const mChannel = path.match(/^\/([A-Za-z0-9_]+)\/?$/);
  if (mChannel && !["directory", "p", "videos", "settings"].includes(mChannel[1])) {
    return { kind: "channel", site: "twitch", url: `https://www.twitch.tv/${mChannel[1]}/videos` };
  }
  return null;
}

function classifySoundCloud(host, u) {
  if (host !== "soundcloud.com") return null;
  const path = u.pathname;
  // Альбом / плейлист: /<user>/sets/<slug>
  if (/^\/[^/]+\/sets\/[^/]+/.test(path)) {
    return { kind: "playlist", site: "soundcloud", url: u.origin + path };
  }
  // Профиль артиста: /<user> (без второго сегмента)
  const mUser = path.match(/^\/([^/]+)\/?$/);
  if (mUser && !["discover", "stream", "you", "upload", "search", "tags", "charts"].includes(mUser[1])) {
    return { kind: "channel", site: "soundcloud", url: u.origin + "/" + mUser[1] };
  }
  // Трек: /<user>/<slug>
  if (/^\/[^/]+\/[^/]+/.test(path)) {
    return { kind: "video", site: "soundcloud", url: u.origin + path };
  }
  return null;
}

function classifyReddit(host, u) {
  if (host !== "reddit.com" && host !== "old.reddit.com") return null;
  const path = u.pathname;
  // Пост: /r/<sub>/comments/<id>/...
  if (/^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(path)) {
    return { kind: "video", site: "reddit", url: "https://www.reddit.com" + path };
  }
  // Сабреддит: /r/<sub>
  const mSub = path.match(/^\/r\/([^/]+)\/?$/);
  if (mSub) {
    return { kind: "channel", site: "reddit", url: `https://www.reddit.com/r/${mSub[1]}` };
  }
  return null;
}

function classifyInstagram(host, u) {
  if (host !== "instagram.com") return null;
  const path = u.pathname;
  // Пост / Reel / IGTV
  if (/^\/(p|reel|reels|tv)\/[^/]+/.test(path)) {
    return { kind: "video", site: "instagram", url: u.origin + path };
  }
  // Профиль: /<user>
  const mUser = path.match(/^\/([A-Za-z0-9._]+)\/?$/);
  if (mUser && !["explore", "accounts", "direct", "stories"].includes(mUser[1])) {
    return { kind: "channel", site: "instagram", url: u.origin + "/" + mUser[1] };
  }
  return null;
}

// Главная функция — пробует все экстракторы по очереди.
function classifyUrl(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = normHost(u.hostname);

  return (
    classifyYouTube(host, u) ||
    classifyTwitter(host, u) ||
    classifyTwitch(host, u) ||
    classifySoundCloud(host, u) ||
    classifyReddit(host, u) ||
    classifyInstagram(host, u)
  );
}

// === Контекстное меню ===
const SITE_PATTERNS = [
  "*://*.youtube.com/*",
  "*://youtu.be/*",
  "*://twitter.com/*",
  "*://*.twitter.com/*",
  "*://x.com/*",
  "*://*.x.com/*",
  "*://*.twitch.tv/*",
  "*://soundcloud.com/*",
  "*://*.soundcloud.com/*",
  "*://*.reddit.com/*",
  "*://*.instagram.com/*",
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ytdlp-download-link",
      title: "Скачать через yt-dlp",
      contexts: ["link"],
      targetUrlPatterns: SITE_PATTERNS,
    });
    chrome.contextMenus.create({
      id: "ytdlp-download-page",
      title: "Скачать эту страницу через yt-dlp",
      contexts: ["page"],
      documentUrlPatterns: SITE_PATTERNS,
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === "ytdlp-download-link" ? info.linkUrl : (tab && tab.url) || info.pageUrl;
  const cls = classifyUrl(url);
  if (!cls) {
    notify("yt-dlp Bridge", "Не похоже на поддерживаемую ссылку");
    return;
  }

  // Простой запуск с дефолтами. Хочешь выбрать качество — открой попап.
  let body = { url: cls.url };
  if (cls.kind === "video") {
    body.mode = "video";
    body.quality = "1080";
  } else if (cls.kind === "playlist") {
    body.mode = "playlist";
    body.range = "all";
    body.format = "video";
    body.subfolder = true;
  } else if (cls.kind === "channel") {
    body.mode = "channel";
    body.range = "10";
    body.format = "video";
    body.subfolder = true;
  }

  try {
    const res = await fetch(`${SERVER}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      notify("yt-dlp Bridge", `✓ В очереди (#${data.id})\n${cls.url}`);
    } else {
      notify("yt-dlp Bridge", `✗ ${data.error || "ошибка"}`);
    }
  } catch (e) {
    notify("yt-dlp Bridge", "Сервер не отвечает.\nЗапусти start-server.bat");
  }
});

function notify(title, message) {
  // chrome.notifications требует отдельный permission, не плодим.
  // Видеть лог можно через chrome://extensions → "Просмотр" service worker.
  console.log(`[ytdlp-bridge] ${title}: ${message}`);
}

// API для попапа
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "classify") {
    sendResponse(classifyUrl(msg.url));
    return true;
  }
});
