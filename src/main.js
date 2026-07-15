// MC-ROLEPLAY.DE Launcher — Main Process (Stufe 1, ohne Microsoft-Login)
// Ablauf: Java finden -> packwiz-Sync -> Forge sicherstellen -> Profil upserten -> offiziellen Launcher starten.
"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns").promises;
const { spawn } = require("child_process");
const auth = require("./auth");
const mcLaunch = require("./launch");

// ---------------------------------------------------------------------------
// CONFIG — zentrale Konstanten
// ---------------------------------------------------------------------------
const CONFIG = {
  PACK_URL: "https://mc-roleplay.de/pack/pack.toml",
  FORGE_VERSION: "1.20.1-forge-47.4.10",
  FORGE_INSTALLER_URL:
    "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-installer.jar",
  TEMURIN_JRE_URL:
    "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse",
  RAM_MB: 8192,
  MC_SERVER_HOST: "mc-roleplay.net",
  MC_SERVER_PORT: 25565,
  CRASH_UPLOAD_URL: "https://mc-roleplay.de/api/crash",
};

// App-Datenverzeichnis: %APPDATA%\MC-ROLEPLAY.DE\
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const DATA_DIR = path.join(APPDATA, "MC-ROLEPLAY.DE");
const INSTANCE_DIR = path.join(DATA_DIR, "instance"); // gameDir
const RUNTIME_DIR = path.join(DATA_DIR, "runtime"); // eigenes Java
const CACHE_DIR = path.join(DATA_DIR, "cache"); // Downloads

const MC_DIR = path.join(APPDATA, ".minecraft");
const NATIVES_DIR = path.join(DATA_DIR, "natives");   // Stufe 2: eigene natives-Extraktion
const ACCOUNT_PATH = path.join(DATA_DIR, "account.dat"); // verschluesselter Refresh-Token
const MC_MISSING_MSG =
  "Der offizielle Minecraft Launcher wurde nicht gefunden. " +
  "Bitte einmal den offiziellen Minecraft Launcher installieren/starten, danach hier erneut auf SPIELEN klicken.";

function javaArgsFor(ramMb) {
  return (
    `-Xmx${ramMb}M -Xms2048M -XX:+UseG1GC -XX:+UnlockExperimentalVMOptions ` +
    `-XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M`
  );
}

// RAM-Grenzen: identisch mit dem Slider im Renderer (8-16 GB).
// VORGABE (Aaron, 13.07.2026): Das Modpack braucht IMMER mindestens 8 GB Heap —
// weniger ist nicht einstellbar. Wer systemseitig nicht genug Speicher frei hat,
// wird beim Start gewarnt und das Spiel startet NICHT (checkMemoryPreflight),
// statt wie frueher den Heap zu verkleinern.
const RAM_MIN_MB = 8192;
const RAM_MAX_MB = 16384;

function defaultRamMb() {
  return RAM_MIN_MB;   // 8 GB Pflicht-Minimum fuer alle Systeme
}

/**
 * Speicher-Preflight vor dem Spielstart: prueft NUR den PHYSISCH VERBAUTEN RAM.
 *
 * WICHTIG (Lehre aus v0.4.1, 14.07.2026): Die fruehere Zusatz-Pruefung auf "freien"
 * Commit (FreeVirtualMemory) hat faelschlich Spieler geblockt, die genug RAM haben —
 * Windows vergroessert die Auslagerungsdatei bei Bedarf automatisch, der Momentanwert
 * unterschaetzt also das tatsaechlich Verfuegbare. Aaron-Vorgabe: nur physischer RAM.
 */
function checkMemoryPreflight(_ramMb) {
  const totalPhysMb = Math.round(os.totalmem() / (1024 * 1024));
  // 8 GB Heap + Betriebssystem + Spiel-Overhead passen physisch nicht in einen
  // Rechner unter ~12 GB. (11500 statt 12288: Hersteller-Angaben liegen unter dem
  // Marketing-Wert, weil BIOS/iGPU etwas abzweigen — 12-GB-PCs melden z.B. ~11,9 GB.)
  if (totalPhysMb < 11500) {
    return {
      ok: false,
      message:
        `Dein PC hat nur ${Math.round(totalPhysMb / 1024)} GB Arbeitsspeicher. ` +
        `Das Modpack benoetigt mindestens 8 GB Java-Speicher plus System — ` +
        `dafuer sind mindestens 12 GB RAM noetig (empfohlen: 16 GB).`,
    };
  }
  return { ok: true };
}

// Persistente Einstellungen (%APPDATA%\MC-ROLEPLAY.DE\settings.json)
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) || {}; } catch (_e) { /* Defaults */ }

  // Einmal-Migration v0.4.1: 8 GB sind jetzt Pflicht-Minimum (Aaron-Vorgabe) —
  // alle persistierten Werte darunter (inkl. der frueheren v0.3.6-Absenkung auf
  // 6144/5120) werden einmalig angehoben. Der Schutz vor "insufficient memory"
  // laeuft jetzt ueber checkMemoryPreflight statt ueber kleinere Heaps.
  if (typeof s.ramMb === "number" && s.ramMb < RAM_MIN_MB && !s.ramMigratedV041) {
    s.ramMb = RAM_MIN_MB;
    s.ramMigratedV041 = true;
    try { saveSettings(s); } catch (_e) { /* beim naechsten Speichern */ }
  }

  const ramMb =
    typeof s.ramMb === "number" && s.ramMb >= RAM_MIN_MB && s.ramMb <= RAM_MAX_MB ? s.ramMb : defaultRamMb();
  // Crash-Reports standardmaessig AN (automatisch), aber abschaltbar
  const sendCrashReports = s.sendCrashReports !== false;
  // Triggerwarnung beim Spielstart standardmaessig AN (sicherer Default), abschaltbar
  const showDisclaimer = s.showDisclaimer !== false;
  return { ramMb, sendCrashReports, showDisclaimer };
}

/**
 * Schreibt die Client-Praeferenzen in die Spiel-Instanz — die RoleplayCore-Mod liest
 * diese Datei beim Start (config/roleplaycore_client_prefs.json) und ueberspringt
 * z.B. die Triggerwarnung, wenn der Spieler sie hier deaktiviert hat.
 * Sicherer Default: existiert die Datei nicht, zeigt die Mod die Warnung.
 */
function writeClientPrefs() {
  try {
    const dir = path.join(INSTANCE_DIR, "config");
    fs.mkdirSync(dir, { recursive: true });
    const prefs = { showDisclaimer: loadSettings().showDisclaimer };
    fs.writeFileSync(path.join(dir, "roleplaycore_client_prefs.json"),
      JSON.stringify(prefs, null, 2), "utf8");
  } catch (_e) { /* nicht kritisch — Mod nutzt sicheren Default */ }
}
function saveSettings(settings) {
  ensureDirs();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

const IS_SMOKE = process.argv.includes("--smoke");
const IS_SELFTEST = process.argv.includes("--selftest");

let mainWindow = null;
let playRunning = false;

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
function ensureDirs() {
  for (const dir of [DATA_DIR, INSTANCE_DIR, RUNTIME_DIR, CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** JSON atomar schreiben: erst .tmp, dann umbenennen — nie halbe Dateien hinterlassen. */
function writeJsonAtomic(filePath, obj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

/** Laeuft ein Prozess mit diesem Bildnamen? (tasklist, ohne Shell-Interpolation) */
async function isProcessRunning(imageName) {
  try {
    const r = await runProcessCapture("tasklist.exe", ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"]);
    return r.output.toLowerCase().includes(imageName.toLowerCase());
  } catch (_e) {
    return false;
  }
}

/** Freier Plattenplatz (MB) auf dem Laufwerk eines Pfads. */
function freeDiskMb(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Math.round((s.bavail * s.bsize) / (1024 * 1024));
  } catch (_e) {
    return null; // unbekannt -> nicht blockieren
  }
}

/** Prozess ausfuehren und Gesamtausgabe einsammeln (fuer kurze Tool-Aufrufe). */
function runProcessCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let output = "";
    if (child.stdout) child.stdout.on("data", (c) => (output += c.toString("utf8")));
    if (child.stderr) child.stderr.on("data", (c) => (output += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/**
 * Java-Kandidat pruefen: muss ausfuehrbar, 64-Bit und Major-Version >= 17 sein.
 * Ein altes JAVA_HOME (Java 8) darf den Temurin-Fallback nicht blockieren.
 */
async function validateJava(javaExe) {
  try {
    const r = await runProcessCapture(javaExe, ["-version"]);
    if (r.code !== 0) return false;
    const m = r.output.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return false;
    let major = parseInt(m[1], 10);
    if (major === 1 && m[2]) major = parseInt(m[2], 10); // "1.8.0_51" -> 8
    if (major < 17) return false;
    if (!/64-Bit/i.test(r.output)) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

/** HTTP(S)-Download mit manueller Redirect-Verfolgung (Adoptium/Maven leiten weiter). */
function download(url, destPath, onProgress, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": "MC-ROLEPLAY.DE-Launcher/" + app.getVersion() } },
      (res) => {
        // Redirects (301/302/303/307/308) selbst folgen
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Zu viele Weiterleitungen: " + url));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          resolve(download(next, destPath, onProgress, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download fehlgeschlagen (HTTP ${res.statusCode}): ${url}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.min(100, Math.round((received / total) * 100)));
          }
        });
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(destPath)));
        file.on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
        res.on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }
    );
    // Haengende Verbindungen nicht ewig laufen lassen (Socket-Inaktivitaet)
    req.setTimeout(30000, () => {
      req.destroy(new Error("Zeitueberschreitung beim Download: " + url));
    });
    req.on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Prozess starten, stdout/stderr zeilenweise an onLine geben.
 * Loest mit {code, lastLines} auf; wirft NICHT selbst bei code != 0.
 */
function runProcess(cmd, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, Object.assign({ windowsHide: true }, opts || {}));
    const lastLines = [];
    let bufOut = "";
    let bufErr = "";

    const handleChunk = (buf, chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      const rest = lines.pop(); // unvollstaendige letzte Zeile behalten
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        lastLines.push(line);
        if (lastLines.length > 20) lastLines.shift();
        if (onLine) onLine(line);
      }
      return rest;
    };

    if (child.stdout) child.stdout.on("data", (c) => (bufOut = handleChunk(bufOut, c)));
    if (child.stderr) child.stderr.on("data", (c) => (bufErr = handleChunk(bufErr, c)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, lastLines }));
  });
}

/** Rekursiv nach bin\java.exe suchen (begrenzte Tiefe). */
function findJavaIn(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return null;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (
      entry.isFile() &&
      entry.name.toLowerCase() === "java.exe" &&
      path.basename(dir).toLowerCase() === "bin"
    ) {
      return p;
    }
    if (entry.isDirectory()) {
      const found = findJavaIn(p, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function bootstrapJarPath() {
  // In der gepackten App liegt das Jar via extraResources direkt in resources\
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "packwiz-installer-bootstrap.jar");
  }
  return path.join(__dirname, "..", "resources", "packwiz-installer-bootstrap.jar");
}

// ---------------------------------------------------------------------------
// Schritt 1: Java finden (oder Temurin 17 JRE herunterladen)
// ---------------------------------------------------------------------------
async function findJava(send) {
  send("java", "Suche Java-Laufzeitumgebung ...", 0);

  // Kandidaten in Prioritaetsreihenfolge sammeln — jeder wird VALIDIERT
  // (64-Bit, Version >= 17), bevor er verwendet wird. Ein altes Java 8 in
  // JAVA_HOME faellt so einfach durch statt alles zu blockieren.
  const home = os.homedir();
  const candidates = [];
  const own = findJavaIn(RUNTIME_DIR, 6);
  if (own) candidates.push(own);
  candidates.push(
    path.join(home, "curseforge", "minecraft", "Install", "runtime",
      "java-runtime-gamma", "windows-x64", "java-runtime-gamma", "bin", "java.exe"),
    path.join(MC_DIR, "runtime", "java-runtime-gamma", "windows-x64",
      "java-runtime-gamma", "bin", "java.exe")
  );
  const mcRuntime = findJavaIn(path.join(MC_DIR, "runtime"), 7);
  if (mcRuntime) candidates.push(mcRuntime);
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, "bin", "java.exe"));
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (await validateJava(candidate)) return candidate;
    send("java", "Ungeeignetes Java uebersprungen (zu alt/32-Bit): " + candidate, null, true);
  }

  // Nichts Brauchbares -> Temurin 17 JRE laden und entpacken
  send("java", "Kein passendes Java gefunden — lade Java 17 (Temurin) herunter ...", 0);
  const zipPath = path.join(CACHE_DIR, "temurin17-jre.zip");
  await download(CONFIG.TEMURIN_JRE_URL, zipPath, (pct) =>
    send("java", `Lade Java 17 herunter ... ${pct}%`, pct)
  );

  send("java", "Entpacke Java 17 ...", 100);
  // Alte/halb entpackte Runtime wegraeumen, damit kein kaputter Rest liegen bleibt
  try {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  } catch (_e) { /* wird gleich neu angelegt */ }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // tar.exe (seit Windows 10 an Bord) entpackt Zips ohne Shell-Quoting-Fallen
  const result = await runProcess(
    "tar.exe",
    ["-xf", zipPath, "-C", RUNTIME_DIR],
    {},
    (line) => send("java", line, null, true)
  );
  if (result.code !== 0) {
    throw new Error("Java-Archiv konnte nicht entpackt werden:\n" + result.lastLines.join("\n"));
  }

  const extracted = findJavaIn(RUNTIME_DIR, 6);
  if (!extracted || !(await validateJava(extracted))) {
    throw new Error("Java wurde entpackt, ist aber nicht lauffaehig. Bitte den Launcher neu starten.");
  }
  return extracted;
}

// ---------------------------------------------------------------------------
// Schritt 2: Modpack per packwiz-installer-bootstrap synchronisieren
// ---------------------------------------------------------------------------
const SYNC_OK_MARKER = () => path.join(INSTANCE_DIR, ".mcrp-sync-ok");

async function syncPack(javaExe, send, opts) {
  const allowOffline = !!(opts && opts.allowOffline);
  send("sync", "Synchronisiere Modpack ...", 0);

  const jar = bootstrapJarPath();
  if (!fs.existsSync(jar)) {
    throw new Error(
      "Die Update-Komponente fehlt (" + path.basename(jar) + "). " +
      "Vermutlich hat ein Antivirus-Programm sie entfernt — bitte den Launcher in den " +
      "Ausnahmen eintragen und neu installieren."
    );
  }

  // Plattenplatz-Check: Erstinstallation braucht ~2 GB Pack + Puffer
  const firstRun = !fs.existsSync(SYNC_OK_MARKER());
  const freeMb = freeDiskMb(DATA_DIR);
  if (freeMb !== null && freeMb < (firstRun ? 6000 : 1000)) {
    throw new Error(
      "Zu wenig freier Speicherplatz (" + Math.round(freeMb / 1000) + " GB frei). " +
      "Fuer die Installation werden mindestens " + (firstRun ? "6" : "1") + " GB benoetigt."
    );
  }

  // Hinweis, wenn vermutlich noch eine Minecraft-Instanz laeuft (gesperrte Jars)
  if (await isProcessRunning("javaw.exe")) {
    send("sync", "Hinweis: Es laeuft noch ein Java-Spielprozess — falls Minecraft offen ist, bitte schliessen.", null, true);
  }

  const args = [
    "-jar",
    jar,
    "-g", // kein eigenes GUI des Installers
    "-s",
    "client",
    "--pack-folder",
    INSTANCE_DIR,
    CONFIG.PACK_URL,
  ];

  const progressRe = /\((\d+)\/(\d+)\)/;
  const result = await runProcess(javaExe, args, { cwd: INSTANCE_DIR }, (line) => {
    const m = line.match(progressRe);
    if (m) {
      const done = parseInt(m[1], 10);
      const totalCount = parseInt(m[2], 10);
      const pct = totalCount > 0 ? Math.round((done / totalCount) * 100) : null;
      send("sync", line, pct, true);
    } else {
      send("sync", line, null, true);
    }
  });

  if (result.code !== 0) {
    const detail = result.lastLines.join("\n");
    // Offline-Toleranz: Wenn schon einmal erfolgreich gesynct wurde und der
    // Server/das Internet gerade nicht erreichbar ist, mit dem vorhandenen
    // Stand weiterspielen lassen statt hart zu blockieren.
    const looksLikeNetwork = /UnknownHost|Connect|ConnectException|SocketTimeout|SSLException|Failed to download|java\.net/i.test(detail);
    if (allowOffline && !firstRun && looksLikeNetwork) {
      send("sync", "Update-Server nicht erreichbar — starte mit dem vorhandenen Modpack-Stand.", 100);
      return;
    }
    let hint = "";
    if (/being used by another process|FileSystemException|AccessDenied/i.test(detail)) {
      hint = "\nLaeuft Minecraft gerade noch? Bitte das Spiel schliessen und erneut versuchen.";
    }
    throw new Error(
      "Modpack-Synchronisation fehlgeschlagen (Exit-Code " + result.code + "):\n" + detail + hint
    );
  }
  try {
    fs.writeFileSync(SYNC_OK_MARKER(), new Date().toISOString(), "utf8");
  } catch (_e) { /* Marker ist optional */ }
  enforceLocalMods(send);   // persoenliche Mod-Entscheidungen NACH dem Sync durchsetzen
  send("sync", "Modpack ist aktuell.", 100);
}

// ---------------------------------------------------------------------------
// Persoenliche ("lokale") Mods: nur fuer diese Instanz, nie auf dem Server.
// Das Admin-Tool schreibt instance/mcrp-local.json { removed:[...] }.
// packwiz laesst selbst hinzugefuegte Jars in Ruhe, holt aber geloeschte Pack-Mods
// wieder zurueck -> hier nach dem Sync erneut entfernen, damit die Entscheidung haelt.
// ---------------------------------------------------------------------------
const LOCAL_MODS_FILE = path.join(INSTANCE_DIR, "mcrp-local.json");
function enforceLocalMods(send) {
  try {
    if (!fs.existsSync(LOCAL_MODS_FILE)) return;
    const cfg = JSON.parse(fs.readFileSync(LOCAL_MODS_FILE, "utf8"));
    const removed = Array.isArray(cfg.removed) ? cfg.removed : [];
    const modsDir = path.join(INSTANCE_DIR, "mods");
    let n = 0;
    for (const name of removed) {
      const base = path.basename(String(name));   // Sicherheitsgrenze: nur Dateiname
      const p = path.join(modsDir, base);
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); n++; } catch (_e) {} }
    }
    if (n > 0 && send) send("sync", n + " persoenlich entfernte Mod(s) angewendet.", null, true);
  } catch (_e) { /* lokale Anpassungen sind optional */ }
}

// ---------------------------------------------------------------------------
// Schritt 3: Forge-Client-Installation sicherstellen
// ---------------------------------------------------------------------------
const FORGE_OK_MARKER = path.join(DATA_DIR, "forge-" + CONFIG.FORGE_VERSION + ".ok");

async function ensureForge(javaExe, send) {
  send("forge", "Pruefe Forge-Installation ...", 0);

  if (!fs.existsSync(MC_DIR)) {
    throw new Error(MC_MISSING_MSG);
  }

  const versionDir = path.join(MC_DIR, "versions", CONFIG.FORGE_VERSION);
  // Nur ueberspringen, wenn UNSER Marker eine vollstaendige Installation bestaetigt.
  // Ein existierendes versions-Verzeichnis allein kann von einem abgebrochenen
  // Installer-Lauf stammen (JSON wird frueh geschrieben, Libraries fehlen dann).
  if (fs.existsSync(versionDir) && fs.existsSync(FORGE_OK_MARKER)) {
    send("forge", "Forge " + CONFIG.FORGE_VERSION + " ist bereits installiert.", 100);
    return;
  }

  // Der Forge-Installer verweigert ohne launcher_profiles.json — bei reinen
  // MS-Store-Installationen (launcher_profiles_microsoft_store.json) eine
  // minimale Datei anlegen.
  const classicProfiles = path.join(MC_DIR, "launcher_profiles.json");
  if (!fs.existsSync(classicProfiles)) {
    writeJsonAtomic(classicProfiles, { profiles: {}, settings: {}, version: 3 });
  }

  send("forge", "Lade Forge-Installer herunter ...", 0);
  const installerPath = path.join(CACHE_DIR, "forge-installer.jar");
  await download(CONFIG.FORGE_INSTALLER_URL, installerPath, (pct) =>
    send("forge", `Lade Forge-Installer ... ${pct}%`, pct)
  );

  send("forge", "Installiere Forge (das kann einige Minuten dauern) ...", null);
  const result = await runProcess(
    javaExe,
    ["-jar", installerPath, "--installClient", MC_DIR],
    { cwd: CACHE_DIR },
    (line) => send("forge", line, null, true)
  );
  if (result.code !== 0) {
    throw new Error(
      "Forge-Installation fehlgeschlagen (Exit-Code " +
        result.code +
        "):\n" +
        result.lastLines.join("\n")
    );
  }
  if (!fs.existsSync(versionDir)) {
    throw new Error("Forge-Installer beendet, aber Version " + CONFIG.FORGE_VERSION + " fehlt.");
  }
  fs.writeFileSync(FORGE_OK_MARKER, new Date().toISOString(), "utf8");
  send("forge", "Forge wurde installiert.", 100);
}

// ---------------------------------------------------------------------------
// Schritt 4: Profil im offiziellen Launcher anlegen/aktualisieren
// ---------------------------------------------------------------------------
/** Alle Profil-Dateien, die der offizielle Launcher je nach Variante nutzt. */
function profileFilePaths() {
  const paths = [];
  const classic = path.join(MC_DIR, "launcher_profiles.json");
  const msStore = path.join(MC_DIR, "launcher_profiles_microsoft_store.json");
  if (fs.existsSync(classic)) paths.push(classic);
  if (fs.existsSync(msStore)) paths.push(msStore);
  return paths;
}

function upsertProfileIn(profilesPath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  } catch (e) {
    throw new Error(path.basename(profilesPath) + " konnte nicht gelesen werden: " + e.message);
  }
  if (typeof data !== "object" || data === null) data = {};
  if (typeof data.profiles !== "object" || data.profiles === null) data.profiles = {};

  const now = new Date().toISOString();
  const existing = data.profiles["mc-roleplay"] || {};
  data.profiles["mc-roleplay"] = Object.assign({}, existing, {
    name: "MC-ROLEPLAY.DE",
    type: "custom",
    icon: "Furnace",
    lastVersionId: CONFIG.FORGE_VERSION,
    gameDir: INSTANCE_DIR,
    javaArgs: javaArgsFor(loadSettings().ramMb),
    created: existing.created || now,
    lastUsed: now,
  });
  writeJsonAtomic(profilesPath, data);
}

async function ensureProfile(send) {
  send("profile", "Richte Launcher-Profil ein ...", 0);

  const paths = profileFilePaths();
  if (paths.length === 0) {
    throw new Error(MC_MISSING_MSG);
  }
  // Ob der offizielle Launcher offen ist, wird NICHT mehr blockiert (viele Spieler
  // haben ihn dauerhaft offen). Das Profil wird atomar geschrieben; falls der
  // Launcher offen war, weist die Schlussmeldung auf einen Neustart hin.
  const launcherWasOpen =
    (await isProcessRunning("MinecraftLauncher.exe")) || (await isProcessRunning("Minecraft.exe"));
  for (const p of paths) upsertProfileIn(p);
  send("profile", "Profil MC-ROLEPLAY.DE ist eingerichtet.", 100);
  return { launcherWasOpen };
}

// ---------------------------------------------------------------------------
// Schritt 5: Offiziellen Minecraft Launcher starten
// ---------------------------------------------------------------------------
function spawnDetached(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    } catch (_e) {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.unref();
    // spawn-Fehler (EACCES etc.) kommen asynchron — kurz warten
    setTimeout(() => resolve(true), 300);
  });
}

// ── Stufe 2: Direktstart-Voraussetzungen ────────────────────────────────────
/** Sind Vanilla-Client-Jar + passender Asset-Index vorhanden (dann koennen wir selbst starten)? */
function directLaunchReady() {
  try {
    const forge = mcLaunch.readVersion(MC_DIR, CONFIG.FORGE_VERSION);
    const vanillaJar = path.join(MC_DIR, "versions", forge.inheritsFrom, forge.inheritsFrom + ".jar");
    const vanilla = mcLaunch.readVersion(MC_DIR, forge.inheritsFrom);
    const idxId = (vanilla.assetIndex && vanilla.assetIndex.id) || forge.inheritsFrom;
    const idx = path.join(MC_DIR, "assets", "indexes", idxId + ".json");
    return fs.existsSync(vanillaJar) && fs.existsSync(idx);
  } catch (_e) { return false; }
}
function directLaunchCfg(javaExe) {
  return {
    mcDir: MC_DIR,
    instanceDir: INSTANCE_DIR,
    nativesDir: NATIVES_DIR,
    javaExe: javaExe,
    ramArgs: javaArgsFor(loadSettings().ramMb).split(/\s+/).filter(Boolean),
    forgeVersionId: CONFIG.FORGE_VERSION,
    launcherName: "mc-roleplay-launcher",
    launcherVersion: app.getVersion(),
  };
}

async function launchOfficial(send, launcherWasOpen) {
  send("launch", "Starte den offiziellen Minecraft Launcher ...", null);

  const reopenHint = launcherWasOpen
    ? " (Der Launcher war schon offen — falls das Profil MC-ROLEPLAY.DE fehlt, ihn einmal schliessen und neu starten.)"
    : "";

  const exeCandidates = [
    "C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe",
    "C:\\Program Files\\Minecraft Launcher\\MinecraftLauncher.exe",
  ];

  for (const exe of exeCandidates) {
    if (fs.existsSync(exe)) {
      if (await spawnDetached(exe, [])) {
        send("done", "Fertig — im Minecraft Launcher das Profil MC-ROLEPLAY.DE wählen und spielen!" + reopenHint, 100);
        return;
      }
    }
  }

  // MS-Store-Version ueber das Apps-Shell-Protokoll (Erfolg nicht messbar,
  // deshalb ehrliche Meldung mit Plan B)
  await spawnDetached("explorer.exe", ["shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft"]);
  send(
    "done",
    "Fertig! Falls sich der Minecraft Launcher nicht von selbst oeffnet: bitte manuell starten " +
      "und das Profil MC-ROLEPLAY.DE wählen (oder den Launcher von minecraft.net installieren)." + reopenHint,
    100
  );
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle("play", async (event) => {
  if (playRunning) {
    return { ok: false, error: "Es laeuft bereits ein Vorgang." };
  }
  playRunning = true;
  writeClientPrefs();   // Praeferenzen (z.B. Triggerwarnung) vor jedem Start in die Instanz spiegeln

  const send = (step, message, percent, isLog) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("status", {
        step,
        message,
        percent: typeof percent === "number" ? percent : null,
        log: !!isLog,
      });
    }
  };

  try {
    ensureDirs();
    // Speicher-Preflight: Modpack braucht 8+ GB Heap — reicht der Systemspeicher
    // nicht, wird verstaendlich gewarnt und NICHT gestartet (statt spaeter zu crashen).
    send("java", "Pruefe Arbeitsspeicher ...", null, true);
    const mem = checkMemoryPreflight(loadSettings().ramMb);
    if (!mem.ok) {
      throw new Error(mem.message);
    }
    // Preflight VOR dem 1,5-GB-Sync: Ist der offizielle Launcher ueberhaupt da?
    if (!fs.existsSync(MC_DIR) || profileFilePaths().length === 0) {
      throw new Error(MC_MISSING_MSG);
    }
    // Stufe 2: stiller Microsoft-Login aus gespeichertem Token (Refresh).
    send("java", "Melde bei Microsoft an ...", null, true);
    const session = await auth.silentSession();
    if (!session) {
      return { ok: false, needLogin: true,
        error: "Bitte zuerst mit deinem Microsoft-Konto anmelden." };
    }
    const javaExe = await findJava(send);
    send("java", "Java gefunden: " + javaExe, 100, true);
    await syncPack(javaExe, send, { allowOffline: true });
    await ensureForge(javaExe, send);

    // Direktstart braucht die Vanilla-Client-Jar + Assets. Fehlen sie (ganz neuer PC ohne
    // je gestarteten offiziellen Launcher), fallen wir auf den offiziellen Launcher zurueck,
    // der sie herunterlaedt. Bestandsspieler starten direkt — der offizielle Launcher entfaellt.
    if (!directLaunchReady()) {
      const { launcherWasOpen } = await ensureProfile(send);
      await launchOfficial(send, launcherWasOpen);
      return { ok: true };
    }
    send("launch", "Starte Minecraft ...", null);
    const { child, logFile } = await mcLaunch.launchGame(directLaunchCfg(javaExe), session);
    // Fruehsterbe-Wache: stirbt der Java-Prozess in den ersten 15 s, schlug der Start fehl
    // -> echten Fehler aus dem Spiel-Log an die Oberflaeche bringen (nie stumm scheitern).
    const earlyExit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    if (earlyExit) {
      let tail = "";
      try { tail = fs.readFileSync(logFile, "utf8").slice(-700).trim(); } catch (_e) {}
      throw new Error("Minecraft-Start fehlgeschlagen (Prozess sofort beendet)." +
        (tail ? "\nLetzte Zeilen aus dem Log:\n" + tail : " (Log leer: " + logFile + ")"));
    }
    send("done", "Minecraft startet — viel Spass, " + session.name + "!", 100);
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    send("error", message, null);
    return { ok: false, error: message };
  } finally {
    playRunning = false;
  }
});

// Nur Modpack synchronisieren (ohne Forge/Profil/Launcher-Start)
ipcMain.handle("sync-pack", async (event) => {
  if (playRunning) {
    return { ok: false, error: "Es laeuft bereits ein Vorgang." };
  }
  playRunning = true;
  const send = (step, message, percent, isLog) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("status", {
        step,
        message,
        percent: typeof percent === "number" ? percent : null,
        log: !!isLog,
      });
    }
  };
  try {
    ensureDirs();
    const javaExe = await findJava(send);
    await syncPack(javaExe, send);
    send("done", "Modpack ist auf dem neuesten Stand.", 100);
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    send("error", message, null);
    return { ok: false, error: message };
  } finally {
    playRunning = false;
  }
});

/** Kleinen Text per HTTP(S) laden (pack.toml vom Server). */
function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": "MC-ROLEPLAY.DE-Launcher/" + app.getVersion() }, timeout: 8000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(fetchText(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("Zeitueberschreitung")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Minecraft Server-List-Ping (Status + Spielerzahl von mc-roleplay.net)
// ---------------------------------------------------------------------------
function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= buffer.length) return null; // noch nicht genug Daten
    const b = buffer[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
    if (shift > 35) throw new Error("VarInt ungueltig");
  }
}

function slpPing(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Zeitueberschreitung"));
    }, timeoutMs);
    let buf = Buffer.alloc(0);

    socket.on("connect", () => {
      // WICHTIG: Im Handshake steht das SRV-ZIEL (play.mc-roleplay.net) — GENAU wie
      // beim echten MC-Client (der nach SRV-Aufloesung das Ziel sendet, wiki.vg).
      // TCPShield matcht darueber das Netzwerk; die Root-Domain ist dort NICHT
      // registriert und wuerde mit "Invalid hostname" (0/0 Spieler) abgelehnt.
      const hostBuf = Buffer.from(host, "utf8");
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshakeBody = Buffer.concat([
        writeVarInt(0x00),          // Packet-ID Handshake
        writeVarInt(763),           // Protokoll 1.20.1
        writeVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        writeVarInt(1),             // Next state: Status
      ]);
      const statusBody = writeVarInt(0x00); // Status-Request
      socket.write(Buffer.concat([
        writeVarInt(handshakeBody.length), handshakeBody,
        writeVarInt(statusBody.length), statusBody,
      ]));
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const lenRes = readVarInt(buf, 0);
        if (!lenRes) return;
        const [pktLen, o1] = lenRes;
        if (buf.length < o1 + pktLen) return;
        const idRes = readVarInt(buf, o1);
        if (!idRes) return;
        const strRes = readVarInt(buf, idRes[1]);
        if (!strRes) return;
        const [strLen, o3] = strRes;
        if (buf.length < o3 + strLen) return;
        const json = JSON.parse(buf.slice(o3, o3 + strLen).toString("utf8"));
        clearTimeout(timer);
        socket.destroy();
        resolve(json);
      } catch (err) {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function pingMcServer() {
  let host = CONFIG.MC_SERVER_HOST;
  let port = CONFIG.MC_SERVER_PORT;
  // SRV-Record beruecksichtigen (_minecraft._tcp), wie es der MC-Client tut
  try {
    const srv = await dns.resolveSrv("_minecraft._tcp." + CONFIG.MC_SERVER_HOST);
    if (srv && srv.length > 0) {
      host = srv[0].name;
      port = srv[0].port;
    }
  } catch (_e) { /* kein SRV — Standardport nutzen */ }
  try {
    const status = await slpPing(host, port);
    return {
      online: true,
      players: status && status.players ? {
        online: status.players.online || 0,
        max: status.players.max || 0,
      } : null,
    };
  } catch (_e) {
    return { online: false };
  }
}

async function fetchRemotePack() {
  try {
    const txt = await fetchText(CONFIG.PACK_URL);
    const name = (txt.match(/^name\s*=\s*"(.+)"\s*$/m) || [])[1] || "Modpack";
    const version = (txt.match(/^version\s*=\s*"(.+)"\s*$/m) || [])[1] || null;
    return { ok: true, name, version };
  } catch (_e) {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Crash-Reports: neue Minecraft-Crashes automatisch an den Server melden
// (der leitet sie an Discord weiter). Abschaltbar in den Einstellungen.
// ---------------------------------------------------------------------------
const CRASH_DIR = path.join(INSTANCE_DIR, "crash-reports");
const SENT_CRASHES_PATH = path.join(DATA_DIR, "sent-crashes.json");

function loadSentCrashes() {
  try { return new Set(JSON.parse(fs.readFileSync(SENT_CRASHES_PATH, "utf8"))); }
  catch (_e) { return null; } // null = noch nie gelaufen
}
function saveSentCrashes(set) {
  try { fs.writeFileSync(SENT_CRASHES_PATH, JSON.stringify([...set].slice(-500)), "utf8"); }
  catch (_e) { /* egal */ }
}

/** Kleinen JSON-Body per HTTPS POST senden (feuern und vergessen). */
function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "User-Agent": "MC-ROLEPLAY.DE-Launcher/" + app.getVersion(),
      },
      timeout: 15000,
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Sammelt Crash-Dateien aus allen relevanten Quellen:
 *  - crash-reports/*.txt        normale Minecraft-Crashes (Java-Exception sauber gefangen)
 *  - hs_err_pid*.log            HARTE Abstuerze (JVM/Grafiktreiber/native Mods) — kein .txt!
 *  - crash-reports/hs_err*.log  (manche landen dort)
 * hs_err-Logs koennen im gameDir, in .minecraft oder in crash-reports liegen.
 */
function collectCrashFiles() {
  const out = [];
  const seen = new Set();
  const isHsErr = (n) => /^hs_err_pid.*\.(log|mdmp)$/i.test(n);
  const isTxtCrash = (n) => n.toLowerCase().endsWith(".txt");
  const scan = (dir, filter) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      if (!e.isFile() || !filter(e.name) || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ full: path.join(dir, e.name), name: e.name });
    }
  };
  scan(CRASH_DIR, (n) => isTxtCrash(n) || isHsErr(n));
  scan(INSTANCE_DIR, isHsErr);
  scan(MC_DIR, isHsErr);
  return out;
}

// Entfernt sensible Daten (v.a. den Minecraft-Session-Token) aus Crash-Inhalten,
// BEVOR sie das Geraet verlassen. hs_err-Logs enthalten oben die komplette
// JVM-Command-Line inkl. --accessToken (Live-Credential!), --clientId, --xuid.
function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/(--(?:accessToken|clientId|xuid|session)[=\s]+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:accessToken|access_token|session|sessionId)["'=:\s]+)[A-Za-z0-9._-]{16,}/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED_JWT]");
}

async function reportNewCrashes() {
  if (!loadSettings().sendCrashReports) return;
  const files = collectCrashFiles();
  if (files.length === 0) return;

  let sent = loadSentCrashes();
  if (sent === null) {
    // Erster Lauf: vorhandene Crashes als "bekannt" markieren, NICHT rueckwirkend senden
    saveSentCrashes(new Set(files.map((f) => f.name)));
    return;
  }
  for (const f of files) {
    if (sent.has(f.name)) continue;
    try {
      const stat = fs.statSync(f.full);
      if (Date.now() - stat.mtimeMs > 14 * 24 * 3600 * 1000) { sent.add(f.name); continue; } // nur frische
      let content = redactSecrets(fs.readFileSync(f.full, "utf8"));
      if (content.length > 200000) content = content.slice(0, 200000) + "\n[... gekuerzt ...]";
      const status = await postJson(CONFIG.CRASH_UPLOAD_URL, {
        filename: f.name,
        launcherVersion: app.getVersion(),
        os: os.type() + " " + os.release(),
        content,
      });
      // Nur als erledigt markieren, wenn der Server ihn wirklich angenommen hat
      // (bei 503 = Webhook noch nicht aktiv -> spaeter erneut versuchen).
      if (status >= 200 && status < 300) sent.add(f.name);
    } catch (_e) { /* diesen Crash ueberspringen, spaeter erneut versuchen */ }
  }
  saveSentCrashes(sent);
}

// Live-Ueberwachung: solange der Launcher offen ist, werden neue Crash-Dateien
// binnen Sekunden gemeldet (nicht erst beim naechsten Start / im 5-Min-Takt).
let _crashDebounce = null;
function watchCrashes() {
  const trigger = () => {
    clearTimeout(_crashDebounce);
    _crashDebounce = setTimeout(() => reportNewCrashes().catch(() => {}), 3000);
  };
  for (const dir of [CRASH_DIR, INSTANCE_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
    try {
      fs.watch(dir, { persistent: false }, (_ev, fn) => {
        if (fn && (/\.txt$/i.test(fn) || /^hs_err_pid/i.test(fn))) trigger();
      });
    } catch (_e) { /* fs.watch nicht verfuegbar -> Startup + 5-Min-Takt reichen */ }
  }
}

ipcMain.handle("get-info", async () => {
  const [pack, mcServer] = await Promise.all([fetchRemotePack(), pingMcServer()]);
  const s = loadSettings();
  return {
    appVersion: app.getVersion(),
    packUrl: CONFIG.PACK_URL,
    forgeVersion: CONFIG.FORGE_VERSION,
    ramMb: s.ramMb,
    sendCrashReports: s.sendCrashReports,
    showDisclaimer: s.showDisclaimer,
    account: auth.cachedAccount(),   // {name,uuid} oder null
    pack,
    mcServer,
  };
});

// Roh-Settings lesen (ALLE Keys erhalten — loadSettings() filtert und wuerde
// Zusatz-Flags wie ramCustom/ramMigratedV036 beim Speichern verlieren).
function loadRawSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) || {}; } catch (_e) { return {}; }
}

ipcMain.handle("set-crash-reports", (_event, enabled) => {
  const settings = loadRawSettings();
  settings.sendCrashReports = !!enabled;
  saveSettings(settings);
  return { ok: true, sendCrashReports: settings.sendCrashReports };
});

ipcMain.handle("set-disclaimer", (_event, enabled) => {
  const settings = loadRawSettings();
  settings.showDisclaimer = !!enabled;
  saveSettings(settings);
  writeClientPrefs();   // sofort in die Instanz spiegeln
  return { ok: true, showDisclaimer: settings.showDisclaimer };
});

ipcMain.handle("install-update", () => {
  if (app.isPackaged) autoUpdater.quitAndInstall();
  return { ok: true };
});

// ── Microsoft-Login (Stufe 2) ───────────────────────────────────────────────
let loginCancel = false;
ipcMain.handle("auth-status", () => {
  const acc = auth.cachedAccount();
  return { loggedIn: !!acc, name: acc ? acc.name : null };
});
ipcMain.handle("auth-login", async (event) => {
  loginCancel = false;
  try {
    const session = await auth.login(
      (code) => { if (!event.sender.isDestroyed()) event.sender.send("auth-code", code); },
      () => loginCancel);
    return { ok: true, name: session.name };
  } catch (err) {
    const m = err && err.message ? err.message : String(err);
    if (m === "CANCELLED") return { ok: false, cancelled: true };
    return { ok: false, error: m };
  }
});
ipcMain.handle("auth-cancel", () => { loginCancel = true; return { ok: true }; });
ipcMain.handle("auth-logout", () => { auth.logout(); return { ok: true }; });
ipcMain.handle("open-url", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) require("electron").shell.openExternal(url);
  return { ok: true };
});

// Rahmenloses Fenster: eigene Titelleisten-Knoepfe
ipcMain.handle("win-minimize", () => { if (mainWindow) mainWindow.minimize(); return { ok: true }; });
ipcMain.handle("win-close", () => { if (mainWindow) mainWindow.close(); return { ok: true }; });
ipcMain.handle("clipboard-write", (_e, t) => { require("electron").clipboard.writeText(String(t || "")); return { ok: true }; });

ipcMain.handle("set-ram", async (_event, ramMb) => {
  const mb = Math.round(Number(ramMb));
  if (!Number.isFinite(mb) || mb < RAM_MIN_MB || mb > RAM_MAX_MB) {
    throw new Error("Ungueltiger RAM-Wert.");
  }
  const settings = loadRawSettings();
  settings.ramMb = mb;
  settings.ramCustom = true;   // bewusste Nutzer-Wahl -> Migration fasst das nie wieder an
  saveSettings(settings);
  // Bestehendes Launcher-Profil direkt mitziehen — aber nur, wenn der offizielle
  // Launcher gerade NICHT laeuft (sonst ueberschreibt er die Datei beim Beenden;
  // beim naechsten SPIELEN wird das Profil ohnehin aktualisiert).
  try {
    const launcherOpen =
      (await isProcessRunning("MinecraftLauncher.exe")) || (await isProcessRunning("Minecraft.exe"));
    if (!launcherOpen) {
      for (const p of profileFilePaths()) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (data.profiles && data.profiles["mc-roleplay"]) {
          data.profiles["mc-roleplay"].javaArgs = javaArgsFor(mb);
          writeJsonAtomic(p, data);
        }
      }
    }
  } catch (_e) { /* Profil existiert noch nicht — wird beim naechsten Spielen gesetzt */ }
  return { ok: true, ramMb: mb };
});

function versionNewer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

ipcMain.handle("check-update", async () => {
  if (!app.isPackaged) return { state: "dev" };
  try {
    const result = await autoUpdater.checkForUpdates();
    const current = app.getVersion();
    const next = result && result.updateInfo ? result.updateInfo.version : current;
    if (versionNewer(next, current)) return { state: "available", version: next };
    return { state: "none", version: current };
  } catch (err) {
    return { state: "error", message: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle("get-config", () => ({
  packUrl: CONFIG.PACK_URL,
  forgeVersion: CONFIG.FORGE_VERSION,
  ramMb: loadSettings().ramMb,
  appVersion: app.getVersion(),
}));

// ---------------------------------------------------------------------------
// Selbsttest: komplette Kette ohne Launcher-Start (fuer Konsole/CI)
// ---------------------------------------------------------------------------
async function runSelftest() {
  let logCount = 0;
  const send = (step, message, percent, isLog) => {
    if (isLog) {
      logCount += 1;
      if (logCount % 250 !== 0) return; // Log-Flut eindaempfen
    }
    const pct = typeof percent === "number" ? ` (${percent}%)` : "";
    console.log(`[${step}] ${message}${pct}`);
  };
  try {
    ensureDirs();
    const javaExe = await findJava(send);
    console.log("[java] Java: " + javaExe);
    await syncPack(javaExe, send);
    await ensureForge(javaExe, send);
    await ensureProfile(send);
    console.log("SELFTEST OK (Launcher-Start uebersprungen)");
    app.exit(0);
  } catch (err) {
    console.error("SELFTEST FEHLER: " + (err && err.message ? err.message : String(err)));
    app.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Auto-Update des Launchers selbst (GitHub Releases, nur in gepackter App)
// ---------------------------------------------------------------------------
function sendUpdateStatus(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-status", data);
  }
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    sendUpdateStatus({ state: "available", version: info.version });
  });
  autoUpdater.on("download-progress", (p) => {
    sendUpdateStatus({ state: "downloading", percent: p.percent });
  });
  autoUpdater.on("update-downloaded", (info) => {
    sendUpdateStatus({ state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", () => {
    sendUpdateStatus({ state: "error" });
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 30 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// App-Lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    // BEKANNTER ELECTRON-BUG (Windows): transparent:true + resizable:false bricht
    // die Transparenz -> Fenster wird deckend/eckig gemalt (genau das war der
    // "keine runden Ecken"-Fehler seit v0.4.0). Workaround: resizable lassen und
    // die Groesse ueber min/max festnageln — Nutzer kann trotzdem nichts ziehen.
    resizable: true,
    minWidth: 960, maxWidth: 960,
    minHeight: 640, maxHeight: 640,
    frame: false,              // eigene Titelleiste (Minimieren/Schliessen im Renderer)
    // Runde Ecken: Windows' natives DWM-Rounding (opakes Fenster) kann nur ~8px —
    // Aaron will deutlich staerkere Rundung -> transparentes Fenster, die Ecken
    // rundet CSS (body border-radius 20px, Ecken dahinter sind durchsichtig).
    transparent: true,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    // KEIN show:false hier: versteckt erstellte transparente Fenster verlieren unter
    // Windows die Transparenz (-> eckige schwarze Ecken). Ein weisser Start-Blitz ist
    // bei transparent eh unmoeglich, und die preboot-CSS-Klasse haelt den Inhalt
    // unsichtbar, bis die Boot-Animation startet.
    title: "MC-ROLEPLAY.DE",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Runde Ecken GARANTIERT: Fensterform per Windows-API zuschneiden (SetWindowRgn).
  // Unabhaengig von Transparenz/Compositing/Treiber — die Ecken sind danach wirklich
  // WEG (Klicks gehen durch), nicht nur uebermalt. CSS zeichnet denselben Radius,
  // damit die Kante antialiased aussieht.
  // Fensterform per API zuschneiden — aber 2px AUSSERHALB der CSS-Kurve:
  // Die sichtbare Kante ist dadurch IMMER die weich geglaettete CSS-Rundung;
  // der harte (nicht glaettbare) Region-Schnitt liegt knapp dahinter und faellt
  // nicht mehr auf. Auf Systemen MIT funktionierender Transparenz ist der
  // Bereich dazwischen eh durchsichtig -> der Zuschnitt ist dort unsichtbar
  // und macht die Ecken nur sauber klick-durchlaessig. Win-win, immer aktiv.
  mainWindow.webContents.once("did-finish-load", () => applyRoundedRegion(mainWindow, WINDOW_RADIUS_PX + 2));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Ecken-Radius des Launcher-Fensters in CSS-Pixeln — muss zum border-radius in
// renderer/style.css passen (dort ebenfalls 30px).
const WINDOW_RADIUS_PX = 30;

function applyRoundedRegion(win, radiusCssPx) {
  try {
    const { screen } = require("electron");
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const scale = (display && display.scaleFactor) || 1;
    // SetWindowRgn arbeitet in PHYSISCHEN Pixeln -> DPI-Skalierung einrechnen.
    const w = Math.round(bounds.width * scale);
    const h = Math.round(bounds.height * scale);
    const d = Math.round(radiusCssPx * 2 * scale);   // CreateRoundRectRgn will den DURCHMESSER
    const hwndBuf = win.getNativeWindowHandle();
    const hwnd = process.arch === "x64" || process.arch === "arm64"
      ? hwndBuf.readBigUInt64LE(0).toString()
      : String(hwndBuf.readUInt32LE(0));
    // PowerShell als P/Invoke-Vehikel (kein natives Node-Modul noetig).
    // -EncodedCommand umgeht jede Quoting-Hoelle. Rechts/unten +1: Regionsgrenzen sind exklusiv.
    const psScript =
      "Add-Type -Namespace W -Name Api -MemberDefinition '" +
      '[DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int x1,int y1,int x2,int y2,int cx,int cy); ' +
      '[DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd,IntPtr hRgn,bool bRedraw);\'; ' +
      `$r=[W.Api]::CreateRoundRectRgn(0,0,${w + 1},${h + 1},${d},${d}); ` +
      `[W.Api]::SetWindowRgn([IntPtr]${hwnd},$r,$true) | Out-Null`;
    const enc = Buffer.from(psScript, "utf16le").toString("base64");
    require("child_process").execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        try {
          fs.appendFileSync(path.join(DATA_DIR, "region.log"),
            `[${new Date().toISOString()}] hwnd=${hwnd} ${w}x${h} d=${d} ` +
            `err=${err ? err.message : "-"} out=${String(stdout).trim()} stderr=${String(stderr).trim()}\n`);
        } catch (_e2) { /* Log ist Diagnose, nie kritisch */ }
      }
    );
  } catch (_e) { /* schlimmstenfalls bleibt nur die CSS-Rundung */ }
}

// Bewusst KEIN requestSingleInstanceLock: eine verwaiste Sperr-Datei (nach einem
// harten Absturz) machte den Launcher sonst dauerhaft unstartbar. Doppelstarts
// sind unkritisch — der playRunning-Guard verhindert parallele Sync-Vorgaenge.
app.whenReady().then(async () => {
  auth.setAccountPath(ACCOUNT_PATH);   // Stufe 2: wo der verschluesselte Token liegt
  if (IS_SMOKE) {
    console.log("SMOKE OK");
    app.quit();
    return;
  }
  if (process.argv.includes("--launch-test")) {
    // Diagnose: echter End-to-End-Start (stille Anmeldung + Direktstart), Ausgabe in Konsole.
    auth.setAccountPath(ACCOUNT_PATH);
    try {
      console.log("[test] stille Anmeldung ...");
      const session = await auth.silentSession();
      if (!session) { console.log("LAUNCH-TEST: KEIN KONTO (needLogin)"); app.exit(2); return; }
      console.log("[test] angemeldet als " + session.name + " (" + session.uuid + ")");
      const javaExe = await findJava(() => {});
      console.log("[test] java: " + javaExe + " | directLaunchReady=" + directLaunchReady());
      const { child, logFile } = await mcLaunch.launchGame(directLaunchCfg(javaExe), session);
      console.log("[test] gestartet, PID=" + child.pid + " | log: " + logFile);
      const died = await new Promise((res) => {
        const t = setTimeout(() => res(false), 60000);
        child.once("exit", (code) => { clearTimeout(t); res(true); });
      });
      if (died) {
        console.log("LAUNCH-TEST: PROZESS GESTORBEN — Log-Ende:");
        try { console.log(fs.readFileSync(logFile, "utf8").slice(-1500)); } catch (_e) {}
        app.exit(1);
      } else {
        console.log("LAUNCH-TEST OK — Prozess laeuft nach 60s noch (Minecraft laedt/laeuft).");
        try { process.kill(child.pid); console.log("[test] Testprozess beendet."); } catch (_e) {}
        app.exit(0);
      }
    } catch (e) {
      console.error("LAUNCH-TEST FEHLER: " + (e && e.stack ? e.stack : e));
      app.exit(1);
    }
    return;
  }
  if (process.argv.includes("--launch-print")) {
    // Diagnose: baut den Startbefehl mit Platzhalter-Session und gibt ihn aus (startet NICHT).
    try {
      const dummy = { name: "TestPlayer", uuid: "00000000000000000000000000000000",
        accessToken: "TEST_TOKEN", xuid: "0", userType: "msa" };
      const args = mcLaunch.buildArgs(directLaunchCfg("java.exe"), dummy);
      const line = ["java", ...args].join(" ");
      console.log("READY=" + directLaunchReady() + " ARGS=" + args.length + " LEN=" + line.length);
      console.log(line);
      console.log("LAUNCH-PRINT OK");
    } catch (e) { console.error("LAUNCH-PRINT FEHLER: " + (e && e.stack ? e.stack : e)); }
    app.exit(0);
    return;
  }
  if (IS_SELFTEST) {
    runSelftest();
    return;
  }
  if (process.argv.includes("--crash-scan")) {
    const found = collectCrashFiles();
    console.log("Gefundene Crash-Dateien (" + found.length + "): " + found.map((f) => f.name).join(", "));
    await reportNewCrashes();
    console.log("CRASH-SCAN OK");
    app.exit(0);
    return;
  }
  createWindow();
  setupAutoUpdate();
  // Neue Crashes aus vorherigen Sitzungen melden (leise, im Hintergrund) und
  // waehrend der Launcher offen bleibt regelmaessig nachsehen.
  reportNewCrashes().catch(() => {});
  setInterval(() => reportNewCrashes().catch(() => {}), 5 * 60 * 1000);
  watchCrashes();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
