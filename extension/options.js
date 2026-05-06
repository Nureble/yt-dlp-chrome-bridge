const SERVER = (globalThis.YTDLP_BRIDGE_CONFIG && globalThis.YTDLP_BRIDGE_CONFIG.SERVER_URL) || "http://127.0.0.1:5000";

const DEFAULTS = {
  use_archive: true,
  container: "both",
  audio_format: "mp3",
  audio_quality: "0",
  video_quality: "1080",
  sleep: "config",
};

const $serverInfo = document.getElementById("server-info");
const $status = document.getElementById("status");

function setServerInfo(ok, msg) {
  $serverInfo.textContent = msg;
  $serverInfo.className = "server-info " + (ok ? "up" : "down");
}

function applyToUi(s) {
  document.getElementById("video_quality").value = s.video_quality;
  document.getElementById("audio_format").value = s.audio_format;
  document.getElementById("audio_quality").value = s.audio_quality;
  document.getElementById("use_archive").checked = !!s.use_archive;
  document.querySelectorAll('input[name="container"]').forEach((r) => {
    r.checked = r.value === s.container;
  });
  // sleep: "config" | "none" | число
  const $sleepCustom = document.getElementById("sleep_custom");
  let sleepRadio = "config";
  if (s.sleep === "config" || s.sleep === "none") {
    sleepRadio = s.sleep;
    $sleepCustom.value = "";
  } else if (typeof s.sleep === "number" && s.sleep >= 0) {
    sleepRadio = "custom";
    $sleepCustom.value = String(s.sleep);
  }
  document.querySelectorAll('input[name="sleep"]').forEach((r) => {
    r.checked = r.value === sleepRadio;
  });
}

function readUi() {
  const out = {
    video_quality: document.getElementById("video_quality").value,
    audio_format: document.getElementById("audio_format").value,
    audio_quality: document.getElementById("audio_quality").value,
    use_archive: document.getElementById("use_archive").checked,
    container: document.querySelector('input[name="container"]:checked')?.value || "both",
  };
  // sleep
  const sleepRadio = document.querySelector('input[name="sleep"]:checked')?.value || "config";
  if (sleepRadio === "custom") {
    const n = parseInt(document.getElementById("sleep_custom").value, 10);
    out.sleep = !isNaN(n) && n >= 0 ? n : "config";
  } else {
    out.sleep = sleepRadio;
  }
  return out;
}

async function load() {
  try {
    const res = await fetch(`${SERVER}/settings`);
    if (!res.ok) throw new Error("bad status");
    const s = await res.json();
    applyToUi({ ...DEFAULTS, ...s });
    setServerInfo(true, "✓ Сервер работает. Настройки загружены.");
  } catch (e) {
    applyToUi(DEFAULTS);
    setServerInfo(false, "✗ Сервер не отвечает. Запусти start-server.bat и обнови страницу.");
  }
  loadVersion();
}

// === Версия yt-dlp ===
const $version = document.getElementById("ytdlp-version");
const $updateBtn = document.getElementById("update-ytdlp");
const $updateStatus = document.getElementById("update-status");

async function loadVersion() {
  $version.textContent = "…";
  try {
    const res = await fetch(`${SERVER}/version`);
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    if (data.exists && data.version) {
      $version.textContent = data.version;
    } else {
      $version.textContent = "не найдена";
      $version.style.color = "#ff5555";
    }
  } catch {
    $version.textContent = "—";
  }
}

$updateBtn.addEventListener("click", async () => {
  $updateStatus.textContent = "Ставлю в очередь…";
  $updateStatus.className = "status";
  $updateBtn.disabled = true;
  try {
    const res = await fetch(`${SERVER}/update`, { method: "POST" });
    const data = await res.json();
    if (res.ok && data.ok) {
      $updateStatus.textContent = `✓ Запущено (#${data.id}). Прогресс — в попапе расширения.`;
      $updateStatus.className = "status ok";
      // Через ~5 сек обновим версию: если -U успел и закрылся — кэш сбросится
      // на стороне сервера и мы получим новую строку. Если ещё идёт — увидим
      // старую, и можно перезагрузить страницу позже.
      setTimeout(loadVersion, 5000);
      setTimeout(loadVersion, 15000);
    } else if (res.status === 409) {
      $updateStatus.textContent = "⌛ Обновление уже в очереди";
      $updateStatus.className = "status";
    } else {
      $updateStatus.textContent = `✗ ${data.error || "ошибка"}`;
      $updateStatus.className = "status err";
    }
  } catch {
    $updateStatus.textContent = "✗ Сервер не отвечает";
    $updateStatus.className = "status err";
  } finally {
    setTimeout(() => { $updateBtn.disabled = false; }, 2000);
  }
});

async function save() {
  const data = readUi();
  $status.textContent = "Сохраняю…";
  $status.className = "status";
  try {
    const res = await fetch(`${SERVER}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("bad status");
    $status.textContent = "✓ Сохранено";
    $status.className = "status ok";
    setTimeout(() => ($status.textContent = ""), 2500);
  } catch {
    $status.textContent = "✗ Сервер не отвечает";
    $status.className = "status err";
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("reset").addEventListener("click", () => {
  applyToUi(DEFAULTS);
  $status.textContent = "Сброшено в UI. Нажми «Сохранить» чтобы применить.";
  $status.className = "status";
});

load();
