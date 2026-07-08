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
const MC_MISSING_MSG =
  "Der offizielle Minecraft Launcher wurde nicht gefunden. " +
  "Bitte einmal den offiziellen Minecraft Launcher installieren/starten, danach hier erneut auf SPIELEN klicken.";

function javaArgsFor(ramMb) {
  return (
    `-Xmx${ramMb}M -Xms2048M -XX:+UseG1GC -XX:+UnlockExperimentalVMOptions ` +
    `-XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M`
  );
}

// RAM-Grenzen: identisch mit dem Slider im Renderer (4-16 GB)
const RAM_MIN_MB = 4096;
const RAM_MAX_MB = 16384;

/** Standard-RAM abhaengig vom physischen Speicher.
 *  WICHTIG (Crash-Analyse Luis, Juli 2026): Der Minecraft-Prozess committet mit diesem
 *  Modpack ~8-9 GB NATIV zusaetzlich zum Java-Heap (Treiber/Netty/JIT/Mods). Auf einem
 *  16-GB-PC fuehrt Xmx=8G daher in die volle Auslagerungsdatei -> "insufficient memory"
 *  Abstuerze. 16-GB-Systeme bekommen deshalb 6G — das Pack laeuft damit sauber. */
function defaultRamMb() {
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  if (totalMb >= 26000) return 8192;   // 32 GB+: genug Luft fuer 8G Heap
  if (totalMb >= 14000) return 6144;   // 16 GB: 6G Heap = stabil (8G -> Pagefile-Tod)
  if (totalMb >= 10000) return 5120;   // 12 GB
  return RAM_MIN_MB;                   // 8 GB
}

// Persistente Einstellungen (%APPDATA%\MC-ROLEPLAY.DE\settings.json)
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) || {}; } catch (_e) { /* Defaults */ }

  // Einmal-Migration v0.3.6: Der alte Pauschal-Default (8192) wurde bei manchen Spielern
  // als Wert persistiert, ohne dass sie ihn bewusst gewaehlt haben (Uebernehmen-Klick).
  // Auf Systemen, wo 8192 nachweislich Abstuerze verursacht (< 26 GB RAM), einmalig auf
  // die neue Empfehlung absenken. Wer danach bewusst hochstellt (ramCustom), bleibt hoch.
  if (typeof s.ramMb === "number" && s.ramMb === 8192 && !s.ramCustom && !s.ramMigratedV036) {
    const recommended = defaultRamMb();
    if (recommended < 8192) {
      s.ramMb = recommended;
      s.ramMigratedV036 = true;
      try { saveSettings(s); } catch (_e) { /* beim naechsten Speichern */ }
    }
  }

  const ramMb =
    typeof s.ramMb === "number" && s.ramMb >= RAM_MIN_MB && s.ramMb <= RAM_MAX_MB ? s.ramMb : defaultRamMb();
  // Crash-Reports standardmaessig AN (automatisch), aber abschaltbar
  const sendCrashReports = s.sendCrashReports !== false;
  return { ramMb, sendCrashReports };
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
  send("sync", "Modpack ist aktuell.", 100);
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
    // Preflight VOR dem 1,5-GB-Sync: Ist der offizielle Launcher ueberhaupt da?
    if (!fs.existsSync(MC_DIR) || profileFilePaths().length === 0) {
      throw new Error(MC_MISSING_MSG);
    }
    const javaExe = await findJava(send);
    send("java", "Java gefunden: " + javaExe, 100, true);
    await syncPack(javaExe, send, { allowOffline: true });
    await ensureForge(javaExe, send);
    const { launcherWasOpen } = await ensureProfile(send);
    await launchOfficial(send, launcherWasOpen);
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

ipcMain.handle("install-update", () => {
  if (app.isPackaged) autoUpdater.quitAndInstall();
  return { ok: true };
});

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
    minWidth: 880,
    minHeight: 580,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: "#0a0503",
    title: "MC-ROLEPLAY.DE",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Bewusst KEIN requestSingleInstanceLock: eine verwaiste Sperr-Datei (nach einem
// harten Absturz) machte den Launcher sonst dauerhaft unstartbar. Doppelstarts
// sind unkritisch — der playRunning-Guard verhindert parallele Sync-Vorgaenge.
app.whenReady().then(async () => {
  if (IS_SMOKE) {
    console.log("SMOKE OK");
    app.quit();
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
