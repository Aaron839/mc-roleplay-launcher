// MC-ROLEPLAY.DE Launcher — Direktstart von Minecraft (Stufe 2)
// Baut den kompletten Java-Startbefehl aus den Versionsprofilen der .minecraft-Installation
// (Forge 1.20.1-forge-47.4.10 erbt von Vanilla 1.20.1) und startet das Spiel selbst —
// der offizielle Minecraft Launcher wird damit ueberfluessig.
//
// Alles (Forge, Vanilla, Assets, Libraries) ist bereits von der bestehenden Kette
// (ensureForge + offizieller Erststart) vorhanden; hier wird NICHTS heruntergeladen.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WIN_TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const fwd = (p) => p.replace(/\\/g, "/");
const SEP = ";"; // Windows classpath/module separator

// ── Maven-Name -> Pfad ───────────────────────────────────────────────────────
// group:artifact:version[:classifier]  ->  group/artifact/version/artifact-version[-classifier].jar
function mavenToPath(name) {
  const parts = name.split(":");
  const group = parts[0].replace(/\./g, "/");
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts[3];
  const file = artifact + "-" + version + (classifier ? "-" + classifier : "") + ".jar";
  return path.posix.join(group, artifact, version, file);
}
/** group:artifact[:classifier] als Dedupe-Schluessel (Version wird ignoriert). */
function gaKey(name) {
  const p = name.split(":");
  return p[0] + ":" + p[1] + (p[3] ? ":" + p[3] : "");
}
function classifierOf(name) { return name.split(":")[3] || ""; }

// ── OS-Rules auswerten (wir sind Windows x64) ────────────────────────────────
function rulesAllow(rules) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== "windows") match = false;
      if (r.os.arch && r.os.arch !== "x86" && r.os.arch !== "x64") match = false;
      // arch=x86-Regeln (32-bit) ueberspringen wir bewusst (wir sind x64)
      if (r.os.arch === "x86") match = false;
    }
    if (r.features) match = false; // demo / custom_resolution / quickPlay -> nicht aktiv
    if (match) allowed = (r.action === "allow");
  }
  return allowed;
}

function readVersion(mcDir, id) {
  const p = path.join(mcDir, "versions", id, id + ".json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Findet die "client-extra"-Jar (net.minecraft:client:<mc>-<mcp>:extra) in libraries/. */
function findClientExtra(mcDir, forge) {
  const libDir = path.join(mcDir, "libraries");
  // mcpVersion aus den Forge-Game-Args (--fml.mcpVersion)
  const g = flattenArgs(forge.arguments && forge.arguments.game);
  const i = g.indexOf("--fml.mcpVersion");
  const mcp = i >= 0 ? g[i + 1] : null;
  if (mcp) {
    const p = path.join(libDir, mavenToPath("net.minecraft:client:" + forge.inheritsFrom + "-" + mcp + ":extra"));
    if (fs.existsSync(p)) return p;
  }
  // Fallback: irgendeine client-*-extra.jar unter net/minecraft/client
  try {
    const base = path.join(libDir, "net", "minecraft", "client");
    for (const dir of fs.readdirSync(base)) {
      const d = path.join(base, dir);
      for (const f of fs.readdirSync(d)) if (/client-.*-extra\.jar$/i.test(f)) return path.join(d, f);
    }
  } catch (_e) {}
  // Letzter Ausweg: volle Vanilla-Jar (kann Modulkonflikt geben, aber besser als leer)
  return path.join(mcDir, "versions", forge.inheritsFrom, forge.inheritsFrom + ".jar");
}

// ── Argument-Liste (jvm/game) rules-gefiltert flach ausrollen ────────────────
function flattenArgs(args) {
  const out = [];
  for (const a of args || []) {
    if (typeof a === "string") { out.push(a); continue; }
    if (a && a.rules && !rulesAllow(a.rules)) continue;   // Objekt-Arg mit nicht erfuellten Rules -> weg
    if (a && a.value !== undefined) {
      if (Array.isArray(a.value)) out.push(...a.value);
      else out.push(a.value);
    }
  }
  return out;
}

/**
 * Sammelt Bibliotheken aus Forge (Kind) + Vanilla (Elternteil) fuer den Classpath.
 * WICHTIG (1.20.1): natives-windows-Jars gehoeren MIT auf den Classpath — LWJGL/JNA/Netty
 * entpacken ihre DLLs selbst nach ${natives_directory} (SharedLibraryExtractPath).
 * Der Vanilla-Launcher extrahiert seit 1.19 nichts mehr manuell; wir auch nicht.
 * Fremd-OS-natives fallen ueber die rules raus.
 */
function collectLibraries(mcDir, forge, vanilla) {
  const libDir = path.join(mcDir, "libraries");
  const seen = new Set();
  const cp = [];
  const add = (lib) => {
    if (!lib || !lib.name) return;
    if (lib.rules && !rulesAllow(lib.rules)) return;
    const key = gaKey(lib.name);   // enthaelt den classifier -> natives kollidieren nicht mit der Basis-Lib
    if (seen.has(key)) return;     // Forge zuerst -> gewinnt bei group:artifact-Konflikt
    seen.add(key);
    const jp = path.join(libDir, mavenToPath(lib.name));
    if (fs.existsSync(jp)) cp.push(jp);
  };
  for (const l of forge.libraries || []) add(l);   // Kind zuerst
  for (const l of vanilla.libraries || []) add(l);
  return { classpathLibs: cp };
}

/**
 * Baut die komplette Argumentliste (ohne das java-Executable selbst).
 * session darf beim reinen Command-Test Platzhalter enthalten.
 */
function buildArgs(cfg, session) {
  const { mcDir, instanceDir, nativesDir, ramArgs, forgeVersionId, launcherName, launcherVersion } = cfg;
  const forge = readVersion(mcDir, forgeVersionId);
  const vanilla = readVersion(mcDir, forge.inheritsFrom);
  const { classpathLibs } = collectLibraries(mcDir, forge, vanilla);

  // Auf den Classpath gehoert die "client-extra"-Jar (nur Assets/Daten), NICHT die volle
  // Vanilla-Jar (versions/1.20.1/1.20.1.jar mit net.minecraft.*-Klassen) — die wuerde als
  // eigenes Modul "_1._20._1" mit dem von Forge gebauten "minecraft"-Modul kollidieren
  // (ResolutionException). Forge baut das minecraft-Modul selbst aus srg+patch+client-extra.
  const clientExtra = findClientExtra(mcDir, forge);
  const classpath = [...classpathLibs, clientExtra].join(SEP);
  const assetIndex = (vanilla.assetIndex && vanilla.assetIndex.id) || forge.inheritsFrom;

  const vars = {
    natives_directory: nativesDir,
    launcher_name: launcherName,
    launcher_version: launcherVersion,
    classpath: classpath,
    classpath_separator: SEP,
    library_directory: path.join(mcDir, "libraries"),
    version_name: forgeVersionId,
    game_directory: instanceDir,
    assets_root: path.join(mcDir, "assets"),
    game_assets: path.join(mcDir, "assets"),
    assets_index_name: assetIndex,
    auth_player_name: session.name,
    auth_uuid: session.uuid,
    auth_access_token: session.accessToken,
    auth_xuid: session.xuid || "",
    auth_session: "token:" + session.accessToken + ":" + session.uuid,
    clientid: "",
    user_type: session.userType || "msa",
    version_type: forge.type || vanilla.type || "release",
    resolution_width: "1280",
    resolution_height: "720",
  };
  const sub = (s) => String(s).replace(/\$\{([^}]+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  // JVM: Vanilla-jvm (rules) + Forge-jvm, dann RAM-Args; danach mainClass; danach Game-Args
  const jvm = [...flattenArgs(vanilla.arguments && vanilla.arguments.jvm),
               ...flattenArgs(forge.arguments && forge.arguments.jvm)].map(sub);
  const game = [...flattenArgs(vanilla.arguments && vanilla.arguments.game),
                ...flattenArgs(forge.arguments && forge.arguments.game)].map(sub);
  const mainClass = forge.mainClass;

  return [...jvm, ...ramArgs, mainClass, ...game];
}

/** Baut alles und startet Minecraft. Gibt { child, logFile } zurueck. */
async function launchGame(cfg, session) {
  // Frischer natives-Ordner: LWJGL/JNA/Netty entpacken ihre DLLs selbst dorthin.
  // (Aufraeumen entfernt auch Altlasten einer frueheren manuellen Extraktion.)
  try { fs.rmSync(cfg.nativesDir, { recursive: true, force: true }); } catch (_e) {}
  fs.mkdirSync(cfg.nativesDir, { recursive: true });

  const args = buildArgs(cfg, session);

  // javaw.exe statt java.exe -> kein schwarzes Konsolenfenster neben dem Spiel
  let javaExe = cfg.javaExe;
  const javaw = path.join(path.dirname(javaExe), "javaw.exe");
  if (fs.existsSync(javaw)) javaExe = javaw;

  // Spiel-Output in eine Log-Datei — Startfehler duerfen nie unsichtbar sein.
  const logFile = path.join(cfg.instanceDir, "logs", "mcrp-direct-launch.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "w");

  const child = spawn(javaExe, args, {
    cwd: cfg.instanceDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: false,
  });
  child.on("error", (e) => {
    try { fs.writeFileSync(logFile, "SPAWN-FEHLER: " + e.message); } catch (_x) {}
  });
  child.unref();   // Minecraft laeuft unabhaengig weiter, auch wenn der Launcher schliesst
  try { fs.closeSync(logFd); } catch (_e) {}   // Kind haelt das Handle selbst
  return { child, logFile };
}

module.exports = { buildArgs, launchGame, collectLibraries, readVersion };
