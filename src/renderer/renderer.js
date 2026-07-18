// MC-ROLEPLAY.DE Launcher — Renderer (Redesign v0.3.3)
"use strict";

const $ = (id) => document.getElementById(id);
const btnReady = $("btn-ready");
const btnWork = $("btn-work");
const btnStart = $("btn-start");
const btnError = $("btn-error");
const errTitle = $("err-title");
const workStep = $("work-step");
const workPct = $("work-pct");
const workFill = $("work-fill");
const burnEdge = $("burn-edge");
const sparkEmit = $("spark-emit");
const logToggle = $("log-toggle");
const logPanel = $("log-panel");
const serverStatus = $("server-status");
const serverLabel = $("server-label");
const serverMeta = $("server-meta");
const chipModpack = $("chip-modpack");
const chipClient = $("chip-client");
const chipRam = $("chip-ram");
const updatePill = $("update-pill");
const updatePillText = $("update-pill-text");
const gear = $("settings-open");
const overlay = $("settings-overlay");
const panel = $("settings-panel");
const ramSlider = $("ram-slider");
const ramVal = $("ram-val");
const crashToggle = $("crash-toggle");
const disclaimerToggle = $("disclaimer-toggle");
const officialToggle = $("official-toggle");
const settingsApply = $("settings-apply");
// Stufe 2: Microsoft-Login
const accountPill = $("account-pill");
const accountName = $("account-name");
const accountMenu = $("account-menu");
const accountLogout = $("account-logout");
const loginOverlay = $("login-overlay");
const loginIntro = $("login-intro");
const loginCodeBlock = $("login-code");
const loginErrorBlock = $("login-error");
const loginStart = $("login-start");
const loginOpen = $("login-open");
const loginCopy = $("login-copy");
const loginUrl = $("login-url");
const loginCodeValue = $("login-code-value");
const loginStatus = $("login-status");
const loginErrorText = $("login-error-text");
const loginRetry = $("login-retry");
const loginClose = $("login-close");
const logoutOverlay = $("logout-overlay");
const logoutCancel = $("logout-cancel");
const logoutConfirm = $("logout-confirm");
const playText = document.querySelector("#btn-ready .play-text");
const playIcon = document.querySelector("#btn-ready .play-icon");
const winMin = $("win-min");
const winCloseBtn = $("win-close");

let loggedIn = false;
let officialMode = false;   // Start ueber offiziellen Launcher -> kein Login im Client noetig
let lastVerifyUrl = "https://microsoft.com/link";
let lastCode = "";

let busy = false;
let overall = 0;
let updateReady = false;
let logLines = [];

// ---- Boot-Animationen nur einmal — aber erst, wenn alles WIRKLICH bereit ist ----
// Vorher startete die Animation sofort beim Laden: Fonts/Canvas waren noch nicht da
// -> Ruckler und Aufblitzen. Jetzt: Fenster zeigt erst bei ready-to-show (main.js),
// wir warten zusaetzlich auf die Fonts + 2 Frames + kurze Setzzeit, DANN Animation.
(async () => {
  try { await document.fonts.ready; } catch (_e) { /* Animation trotzdem starten */ }
  await new Promise((r) => setTimeout(r, 350));
  let started = false;
  const startBoot = () => {
    if (started) return;
    started = true;
    document.body.classList.remove("preboot");
    document.body.classList.add("boot");
    setTimeout(() => document.body.classList.remove("boot"), 1600);
  };
  // rAF = sauber synchron zum ersten gemalten Frame; feuert aber NIE in unsichtbaren/
  // gedrosselten Fenstern -> Timeout-Fallback, damit der Launcher nie haengen bleibt.
  requestAnimationFrame(() => requestAnimationFrame(startBoot));
  setTimeout(startBoot, 700);
})();

// ---- Log ----
function appendLog(message) {
  const now = new Date();
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0")).join(":");
  logLines.push("[" + t + "] " + message);
  if (logLines.length > 400) logLines = logLines.slice(-400);
  logPanel.textContent = logLines.join("\n");
  logPanel.scrollTop = logPanel.scrollHeight;
}
logToggle.addEventListener("click", () => {
  const show = logPanel.hidden;
  logPanel.hidden = !show;
  logToggle.classList.toggle("open", show);
});

// ---- Knopf-Zustände ----
function showPhase(phase) {
  btnReady.hidden = phase !== "bereit";
  btnWork.hidden = phase !== "arbeitet";
  btnStart.hidden = phase !== "startet";
  btnError.hidden = phase !== "fehler";
}

function setWork(label, pct) {
  if (label) workStep.textContent = label;
  const p = Math.round(pct);
  workPct.textContent = p + " %";
  workFill.style.width = p + "%";
  burnEdge.style.left = p + "%";
  sparkEmit.style.left = p + "%";
}

const STEP_LABEL = {
  java: "Prüfe Java-Laufzeit …",
  sync: "Aktualisiere Modpack …",
  forge: "Verifiziere Forge …",
  profile: "Richte Profil ein …",
  launch: "Starte Minecraft …",
};

function updateProgress(step, percent) {
  let base = overall;
  const hasPct = typeof percent === "number" && percent >= 0;
  if (step === "java") base = Math.max(base, 4);
  else if (step === "sync") base = hasPct ? 6 + percent * 0.72 : base;
  else if (step === "forge") base = hasPct ? Math.max(base, 80 + percent * 0.1) : Math.max(base, 84);
  else if (step === "profile") base = Math.max(base, 96);
  else if (step === "launch") base = Math.max(base, 99);
  else if (step === "done") base = 100;
  overall = Math.max(overall, Math.min(100, base));
  setWork(STEP_LABEL[step], overall);
}

window.launcher.onStatus((s) => {
  if (s.message) appendLog(s.message);
  if (s.step && s.step !== "error" && s.step !== "done") updateProgress(s.step, s.percent);
});

// ---- Fenster-Steuerung (rahmenlos) ----
winMin.addEventListener("click", () => window.launcher.winMinimize());
winCloseBtn.addEventListener("click", () => window.launcher.winClose());

// ---- Microsoft-Login ----
function setAccount(name) {
  loggedIn = !!name;
  accountName.textContent = name || "Anmelden";
  accountPill.classList.toggle("online", loggedIn);
  updatePlayLabel();
  if (!loggedIn && accountMenu) accountMenu.hidden = true;
}
// Hauptknopf: SPIELEN wenn eingeloggt ODER Start ueber offiziellen Launcher
// (dort uebernimmt der offizielle Launcher den Login — der Client braucht keinen).
function updatePlayLabel() {
  const canPlay = loggedIn || officialMode;
  if (playText) playText.textContent = canPlay ? "SPIELEN" : "ANMELDEN";
  if (playIcon) playIcon.style.display = canPlay ? "" : "none";
}
function showLoginBlock(which) {
  loginIntro.hidden = which !== "intro";
  loginCodeBlock.hidden = which !== "code";
  loginErrorBlock.hidden = which !== "error";
}
function openLogin() {
  showLoginBlock("intro");
  loginOverlay.hidden = false;
  loginOverlay.classList.remove("closing");
}
function closeLogin() {
  window.launcher.authCancel();
  loginOverlay.classList.add("closing");
  setTimeout(() => { loginOverlay.hidden = true; loginOverlay.classList.remove("closing"); }, 200);
}
async function doLogin() {
  showLoginBlock("code");
  loginCodeValue.textContent = "…";
  loginStatus.textContent = "Warte auf Bestätigung …";
  try {
    const r = await window.launcher.authLogin();
    if (r.ok) {
      setAccount(r.name);
      loginOverlay.hidden = true;
      appendLog("Angemeldet als " + r.name);
      return true;
    }
    if (r.cancelled) { loginOverlay.hidden = true; return false; }
    loginErrorText.textContent = r.error || "Anmeldung fehlgeschlagen.";
    showLoginBlock("error");
  } catch (err) {
    loginErrorText.textContent = err.message || "Anmeldung fehlgeschlagen.";
    showLoginBlock("error");
  }
  return false;
}
window.launcher.onAuthCode((data) => {
  lastVerifyUrl = data.verificationUri || lastVerifyUrl;
  lastCode = data.userCode || "";
  loginUrl.textContent = (data.verificationUri || "microsoft.com/link").replace(/^https?:\/\//, "");
  loginCodeValue.textContent = lastCode || "—";
  loginStatus.textContent = "Warte auf Bestätigung im Browser …";
});
function copyCode() {
  if (!lastCode) return;
  window.launcher.copyText(lastCode);
  loginCopy.textContent = "Kopiert ✓";
  setTimeout(() => { loginCopy.textContent = "Code kopieren"; }, 1500);
}

// Account-Pill: eingeloggt -> Menü (Abmelden); sonst -> Login
accountPill.addEventListener("click", (e) => {
  e.stopPropagation();
  if (loggedIn) accountMenu.hidden = !accountMenu.hidden;
  else openLogin();
});
document.addEventListener("click", () => { if (accountMenu) accountMenu.hidden = true; });
accountLogout.addEventListener("click", () => {
  accountMenu.hidden = true;
  logoutOverlay.hidden = false;
});
logoutCancel.addEventListener("click", () => { logoutOverlay.hidden = true; });
logoutConfirm.addEventListener("click", async () => {
  await window.launcher.authLogout();
  setAccount(null);
  logoutOverlay.hidden = true;
});

loginStart.addEventListener("click", doLogin);
loginRetry.addEventListener("click", doLogin);
loginOpen.addEventListener("click", () => window.launcher.openUrl(lastVerifyUrl));
loginCopy.addEventListener("click", copyCode);
loginCodeValue.addEventListener("click", copyCode);
loginClose.addEventListener("click", closeLogin);

// ---- Spielen-Ablauf ----
async function startPlay() {
  if (busy) return;
  // Stufe 2: nicht angemeldet -> erst Login.
  // AUSSER im Modus "offizieller Launcher": dort loggt der offizielle Launcher ein,
  // der Client startet ohne eigenen Login direkt durch.
  if (!loggedIn && !officialMode) { openLogin(); return; }
  busy = true;
  overall = 0;
  setWork("Starte …", 0);
  showPhase("arbeitet");
  logLines = []; logPanel.textContent = "";
  appendLog("Vorgang gestartet …");
  try {
    const r = await window.launcher.play();
    if (r && r.ok) {
      setWork(null, 100);
      showPhase("startet");
      setTimeout(() => { showPhase("bereit"); busy = false; refreshInfo(); }, 2200);
    } else if (r && r.needLogin) {
      // Token abgelaufen/fehlt -> zurueck zum Login
      setAccount(null);
      showPhase("bereit");
      busy = false;
      openLogin();
    } else {
      const msg = (r && r.error) ? r.error : "Unbekannter Fehler.";
      errTitle.textContent = shortError(msg);
      appendLog("FEHLER: " + msg);
      showPhase("fehler");
      busy = false;
    }
  } catch (err) {
    errTitle.textContent = shortError(err.message);
    appendLog("FEHLER: " + err.message);
    showPhase("fehler");
    busy = false;
  }
}
function shortError(msg) {
  const first = String(msg).split("\n")[0].trim();
  return first.length > 46 ? first.slice(0, 44) + "…" : (first || "Fehlgeschlagen");
}
btnReady.addEventListener("click", startPlay);
btnError.addEventListener("click", startPlay);

// ---- Update-Hinweis ----
window.launcher.onUpdateStatus((u) => {
  if (u.state === "available") {
    updatePill.hidden = false; updatePill.classList.remove("ready");
    updatePillText.textContent = "Launcher-Update v" + u.version + " lädt …";
  } else if (u.state === "downloading" && typeof u.percent === "number") {
    updatePill.hidden = false;
    updatePillText.textContent = "Launcher-Update lädt … " + Math.round(u.percent) + " %";
  } else if (u.state === "downloaded") {
    updateReady = true;
    updatePill.hidden = false; updatePill.classList.add("ready");
    updatePillText.textContent = "Update bereit — neu starten";
  } else if (u.state === "error" && !updateReady) {
    setTimeout(() => { if (!updateReady) updatePill.hidden = true; }, 6000);
  }
});
updatePill.addEventListener("click", () => { if (updateReady) window.launcher.installUpdate(); });

// ---- Einstellungen ----
function openSettings() { overlay.hidden = false; overlay.classList.remove("closing"); }
function closeSettings() {
  overlay.classList.add("closing");
  setTimeout(() => { overlay.hidden = true; overlay.classList.remove("closing"); }, 240);
}
gear.addEventListener("click", openSettings);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeSettings(); });
ramSlider.addEventListener("input", () => { ramVal.textContent = ramSlider.value + " GB"; });
crashToggle.addEventListener("click", () => {
  const on = crashToggle.getAttribute("aria-checked") !== "true";
  crashToggle.setAttribute("aria-checked", on ? "true" : "false");
});
disclaimerToggle.addEventListener("click", () => {
  const on = disclaimerToggle.getAttribute("aria-checked") !== "true";
  disclaimerToggle.setAttribute("aria-checked", on ? "true" : "false");
});
officialToggle.addEventListener("click", () => {
  const on = officialToggle.getAttribute("aria-checked") !== "true";
  officialToggle.setAttribute("aria-checked", on ? "true" : "false");
});
settingsApply.addEventListener("click", async () => {
  settingsApply.disabled = true;
  const gb = parseInt(ramSlider.value, 10);
  const crash = crashToggle.getAttribute("aria-checked") === "true";
  const disclaimer = disclaimerToggle.getAttribute("aria-checked") === "true";
  const official = officialToggle.getAttribute("aria-checked") === "true";
  try {
    await window.launcher.setRam(gb * 1024);
    await window.launcher.setCrashReports(crash);
    await window.launcher.setDisclaimer(disclaimer);
    await window.launcher.setLaunchMode(official ? "official" : "direct");
    officialMode = official;
    updatePlayLabel();
    chipRam.textContent = gb + " GB";
  } catch (_e) { /* still schliessen */ }
  settingsApply.disabled = false;
  closeSettings();
});

// ---- Live-Daten ----
async function refreshInfo() {
  try {
    const info = await window.launcher.getInfo();
    chipClient.textContent = "v" + info.appVersion;
    const gb = Math.round(info.ramMb / 1024);
    chipRam.textContent = gb + " GB";
    chipModpack.textContent = info.pack && info.pack.ok && info.pack.version ? "v" + info.pack.version : "—";
    if (typeof info.launchMode === "string") officialMode = info.launchMode === "official";
    if (info.account && info.account.name) setAccount(info.account.name);
    else if (!loggedIn) setAccount(null);
    updatePlayLabel();
    if (overlay.hidden) {
      ramSlider.value = gb; ramVal.textContent = gb + " GB";
      if (typeof info.sendCrashReports === "boolean") crashToggle.setAttribute("aria-checked", info.sendCrashReports ? "true" : "false");
      if (typeof info.showDisclaimer === "boolean") disclaimerToggle.setAttribute("aria-checked", info.showDisclaimer ? "true" : "false");
      if (typeof info.launchMode === "string") officialToggle.setAttribute("aria-checked", info.launchMode === "official" ? "true" : "false");
    }
    if (info.mcServer && info.mcServer.online) {
      serverStatus.classList.add("online"); serverStatus.classList.remove("offline");
      serverLabel.textContent = "Server online";
      serverMeta.textContent = info.mcServer.players ? "· " + info.mcServer.players.online + "/" + info.mcServer.players.max + " Spieler" : "";
    } else {
      serverStatus.classList.add("offline"); serverStatus.classList.remove("online");
      serverLabel.textContent = "Server offline"; serverMeta.textContent = "";
    }
  } catch (_e) {
    serverLabel.textContent = "Status unbekannt";
  }
}
refreshInfo();
setInterval(() => { if (!busy) refreshInfo(); }, 60 * 1000);

// ---- Server-Status anklickbar: sofort neu pruefen (mit Puls + Ping-Welle) ----
let statusChecking = false;
serverStatus.addEventListener("click", async () => {
  if (statusChecking) return;
  statusChecking = true;
  serverStatus.classList.add("checking");
  serverLabel.textContent = "Prüfe Server …";
  serverMeta.textContent = "";
  const t0 = Date.now();
  try { await refreshInfo(); } catch (_e) { /* refreshInfo faengt selbst */ }
  // Animation mindestens kurz sichtbar lassen (sonst wirkt der Klick "tot")
  const rest = 700 - (Date.now() - t0);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  serverStatus.classList.remove("checking");
  statusChecking = false;
});

// ---- Funken der Brennkante (15, CSS-Loop) ----
(function sparks() {
  let s = 91;
  const r = (a, b) => { s = (s * 9301 + 49297) % 233280; return a + (s / 233280) * (b - a); };
  for (let i = 0; i < 15; i++) {
    const sz = r(2, 4.4), dur = r(0.9, 1.7), delay = -r(0, 1.7), dx = r(-15, 15), topOff = r(34, 64), leftOff = r(-5, 5);
    const span = document.createElement("span");
    span.style.left = leftOff + "px"; span.style.top = topOff + "%";
    span.style.width = sz + "px"; span.style.height = sz + "px";
    span.style.background = i % 3 === 0 ? "#fff4ec" : "#ff9a52";
    span.style.boxShadow = "0 0 " + (sz * 2.3) + "px " + (sz * 0.8) + "px rgba(255,150,80,0.9)";
    span.style.setProperty("--dx", dx.toFixed(1) + "px");
    span.style.animation = "lch-spark " + dur.toFixed(2) + "s ease-out " + delay.toFixed(2) + "s infinite";
    sparkEmit.appendChild(span);
  }
})();

// ---- Glut-Partikel im Hintergrund (Canvas, 26 Stück, Seed 17) ----
(function embers() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("embers");
  const ctx = canvas.getContext("2d");
  let seed = 17;
  const rnd = (a, b) => { seed = (seed * 9301 + 49297) % 233280; return a + (seed / 233280) * (b - a); };
  let W = 0, H = 0, parts = [];
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  window.addEventListener("resize", resize); resize();
  for (let i = 0; i < 26; i++) {
    parts.push({ x: rnd(0, 1), y: rnd(0.08, 0.96), r: rnd(1.5, 4.5), sp: rnd(7, 13), a: rnd(0.35, 0.8), life: rnd(0, 1) });
  }
  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.life += 1 / (p.sp * 60);
      if (p.life > 1) { p.life = 0; p.x = Math.random(); p.y = 0.9 + Math.random() * 0.1; }
      const yPix = (p.y - p.life * (160 / H)) * H;
      const t = p.life;
      const alpha = (t < 0.1 ? t * 10 : 1 - (t - 0.1) / 0.9) * p.a;
      ctx.beginPath();
      ctx.arc(p.x * W, yPix, p.r * (1 - t * 0.6), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,122,60," + Math.max(0, alpha).toFixed(3) + ")";
      ctx.shadowColor = "#ff6b2c"; ctx.shadowBlur = 8;
      ctx.fill(); ctx.shadowBlur = 0;
    }
    requestAnimationFrame(tick);
  }
  tick();
})();
