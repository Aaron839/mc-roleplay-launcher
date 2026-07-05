// MC-ROLEPLAY.DE Launcher — Renderer (Design-System v1)
"use strict";

const playBtn = document.getElementById("play-btn");
const syncBtn = document.getElementById("sync-btn");
const statusLine = document.getElementById("status-line");
const barFill = document.getElementById("bar-fill");
const logEl = document.getElementById("log");
const logToggle = document.getElementById("log-toggle");
const serverLine = document.getElementById("server-line");
const serverText = document.getElementById("server-text");
const updatePill = document.getElementById("update-pill");
const updatePillText = document.getElementById("update-pill-text");
const statPack = document.getElementById("stat-pack");
const statClient = document.getElementById("stat-client");
const statRam = document.getElementById("stat-ram");
const settingsBtn = document.getElementById("settings-btn");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsApply = document.getElementById("settings-apply");
const ramSlider = document.getElementById("ram-slider");
const ramValue = document.getElementById("ram-value");
const crashToggle = document.getElementById("crash-toggle");

const MAX_LOG_LINES = 500;
let logLines = [];
let busy = false;
let updateReady = false;

// ---- Log & Status ----------------------------------------------------------
function appendLog(message) {
  logLines.push(message);
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
  logEl.textContent = logLines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(message, kind) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", kind === "error");
  statusLine.classList.toggle("done", kind === "done");
}

function setProgress(percent) {
  if (typeof percent === "number" && percent >= 0) {
    barFill.style.width = percent + "%";
  }
}

window.launcher.onStatus((s) => {
  if (s.message) {
    appendLog(s.message);
    if (!s.log) {
      setStatus(s.message, s.step === "error" ? "error" : s.step === "done" ? "done" : null);
    }
  }
  setProgress(s.percent);
});

logToggle.addEventListener("click", () => {
  const show = logEl.hidden;
  logEl.hidden = !show;
  logToggle.textContent = show ? "Details ‹" : "Details ›";
});

// ---- Aktionen ----------------------------------------------------------------
function setBusy(state) {
  busy = state;
  playBtn.disabled = state;
  syncBtn.disabled = state;
}

async function runAction(label, fn) {
  if (busy) return;
  setBusy(true);
  setStatus(label, null);
  barFill.style.width = "0%";
  appendLog("== " + label + " ==");
  try {
    const result = await fn();
    if (result && result.ok === false) {
      setStatus("Fehler: " + (result.error || "Unbekannter Fehler."), "error");
      appendLog("FEHLER: " + (result.error || "unbekannt"));
    }
  } catch (err) {
    setStatus("Fehler: " + err.message, "error");
    appendLog("FEHLER: " + err.message);
  } finally {
    setBusy(false);
    refreshInfo();
  }
}

playBtn.addEventListener("click", () => runAction("Starte ...", () => window.launcher.play()));
syncBtn.addEventListener("click", () => runAction("Aktualisiere Modpack ...", () => window.launcher.syncPack()));

// ---- Update-Hinweis (oben rechts, nur bei verfuegbarem Update) -----------------
window.launcher.onUpdateStatus((u) => {
  if (u.state === "available") {
    updatePill.hidden = false;
    updatePill.classList.remove("ready");
    updatePillText.textContent = "UPDATE v" + u.version + " LÄDT ...";
  } else if (u.state === "downloading" && typeof u.percent === "number") {
    updatePill.hidden = false;
    updatePillText.textContent = "UPDATE LÄDT ... " + Math.round(u.percent) + " %";
  } else if (u.state === "downloaded") {
    updateReady = true;
    updatePill.hidden = false;
    updatePill.classList.add("ready");
    updatePillText.textContent = "UPDATE BEREIT — NEU STARTEN";
  } else if (u.state === "error" && !updateReady) {
    // Fehlgeschlagener Download soll nicht ewig "LÄDT ..." anzeigen
    updatePillText.textContent = "UPDATE SPÄTER ERNEUT";
    setTimeout(() => {
      if (!updateReady) updatePill.hidden = true;
    }, 8000);
  }
});

function triggerInstall() {
  if (updateReady) window.launcher.installUpdate();
}
updatePill.addEventListener("click", triggerInstall);
updatePill.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    triggerInstall();
  }
});

// ---- Einstellungen -------------------------------------------------------------
settingsBtn.addEventListener("click", () => { settingsOverlay.hidden = false; });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsOverlay.hidden) settingsOverlay.hidden = true;
});

ramSlider.addEventListener("input", () => {
  ramValue.textContent = ramSlider.value + " GB";
});

settingsApply.addEventListener("click", async () => {
  const gb = parseInt(ramSlider.value, 10);
  settingsApply.disabled = true;
  try {
    await window.launcher.setRam(gb * 1024);
    await window.launcher.setCrashReports(crashToggle.checked);
    statRam.textContent = gb + " GB";
    appendLog("RAM auf " + gb + " GB gesetzt. Crash-Berichte: " + (crashToggle.checked ? "an" : "aus") + ".");
    settingsOverlay.hidden = true;
  } catch (err) {
    appendLog("Einstellung fehlgeschlagen: " + err.message);
  } finally {
    settingsApply.disabled = false;
  }
});

// ---- Info laden (Pack-Version, Client-Version, RAM, Minecraft-Server) -----------
async function refreshInfo() {
  try {
    const info = await window.launcher.getInfo();
    statClient.textContent = "v" + info.appVersion;
    const gb = Math.round(info.ramMb / 1024);
    statRam.textContent = gb + " GB";
    // Regler/Schalter nicht anfassen, waehrend das Einstellungs-Menue offen ist
    if (settingsOverlay.hidden) {
      ramSlider.value = gb;
      ramValue.textContent = gb + " GB";
      if (typeof info.sendCrashReports === "boolean") crashToggle.checked = info.sendCrashReports;
    }
    statPack.textContent = info.pack && info.pack.ok && info.pack.version ? "v" + info.pack.version : "—";

    if (info.mcServer && info.mcServer.online) {
      serverLine.classList.add("online");
      serverLine.classList.remove("offline");
      const p = info.mcServer.players;
      serverText.textContent = p
        ? "SERVER ONLINE · " + p.online + "/" + p.max + " SPIELER"
        : "SERVER ONLINE";
    } else {
      serverLine.classList.add("offline");
      serverLine.classList.remove("online");
      serverText.textContent = "SERVER OFFLINE";
    }
  } catch (_e) {
    serverText.textContent = "STATUS UNBEKANNT";
  }
}
refreshInfo();
setInterval(refreshInfo, 60 * 1000);

// ---- Glut-Partikel ------------------------------------------------------------------
(function embers() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;
  const canvas = document.getElementById("embers");
  const ctx = canvas.getContext("2d");
  let particles = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  function spawn() {
    return {
      x: Math.random() * canvas.width,
      y: canvas.height * (0.55 + Math.random() * 0.5),
      r: 1 + Math.random() * 2.2,
      vy: 0.25 + Math.random() * 0.6,
      vx: (Math.random() - 0.5) * 0.25,
      life: 0,
      max: 240 + Math.random() * 260,
    };
  }
  for (let i = 0; i < 42; i++) {
    const p = spawn();
    p.life = Math.random() * p.max;
    particles.push(p);
  }

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.life += 1;
      p.y -= p.vy;
      p.x += p.vx + Math.sin((p.life + p.max) / 46) * 0.16;
      const t = p.life / p.max;
      const alpha = t < 0.1 ? t * 10 : 1 - (t - 0.1) / 0.9;
      if (t >= 1 || p.y < -10) Object.assign(p, spawn(), { y: canvas.height + 8 });
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 - t * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 122, 60, " + (alpha * 0.65).toFixed(3) + ")";
      ctx.shadowColor = "#ff6b2c";
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    requestAnimationFrame(tick);
  }
  tick();
})();
