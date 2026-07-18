// MC-ROLEPLAY.DE Launcher — Microsoft-Login (Stufe 2)
// Device-Code-Flow: Microsoft -> Xbox Live -> XSTS -> Minecraft.
// Kette 1:1 aus scripts/ms-login-test.mjs (live gegen Mojang verifiziert 09.07.2026).
//
// TRUST: Der Login laeuft DIREKT gegen Microsoft/Mojang. Unser Server sieht weder
// Passwort noch Token. Nur der langlebige Refresh-Token wird lokal gespeichert —
// verschluesselt via Windows-DPAPI (Electron safeStorage). Nichts verlaesst den PC
// ausser zu login.microsoftonline.com / *.xboxlive.com / api.minecraftservices.com.
"use strict";

const fs = require("fs");
const path = require("path");
const { safeStorage } = require("electron");

const CLIENT_ID = "e859a2c8-976c-4f6c-90a7-1d677cf23368";
const SCOPE = "XboxLive.signin offline_access openid profile email";
const TENANT = "consumers";

const form = (o) => new URLSearchParams(o).toString();

async function postForm(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(body),
  });
  return r.json();
}
async function postJson(url, obj) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(obj),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ── Persistenz (verschluesselt) ─────────────────────────────────────────────
let ACCOUNT_PATH = null;
function setAccountPath(p) { ACCOUNT_PATH = p; }

function saveAccount(data) {
  if (!ACCOUNT_PATH) return;
  try {
    const raw = JSON.stringify(data);
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(ACCOUNT_PATH, safeStorage.encryptString(raw));
    }
    // Kein Klartext-Fallback: ohne DPAPI wird der Token bewusst NICHT persistiert.
  } catch (_e) { /* nicht kritisch — dann eben neu einloggen */ }
}
function loadAccount() {
  try {
    if (!ACCOUNT_PATH || !fs.existsSync(ACCOUNT_PATH)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(ACCOUNT_PATH)));
  } catch (_e) { return null; }
}
function clearAccount() {
  try { if (ACCOUNT_PATH && fs.existsSync(ACCOUNT_PATH)) fs.unlinkSync(ACCOUNT_PATH); } catch (_e) {}
}

// ── Device-Code-Flow ────────────────────────────────────────────────────────
async function requestDeviceCode() {
  const dc = await postForm(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
    { client_id: CLIENT_ID, scope: SCOPE });
  if (!dc.device_code) throw new Error("Microsoft-Login nicht erreichbar. Bitte spaeter erneut versuchen.");
  return {
    userCode: dc.user_code,
    verificationUri: dc.verification_uri,
    deviceCode: dc.device_code,
    interval: dc.interval || 5,
    expiresIn: dc.expires_in || 900,
  };
}

/** Wartet, bis der Nutzer im Browser bestaetigt hat. Gibt MSA-Tokens zurueck. */
async function pollForMsa(dc, shouldCancel) {
  const deadline = Date.now() + dc.expiresIn * 1000;
  let interval = dc.interval;
  while (Date.now() < deadline) {
    if (shouldCancel && shouldCancel()) throw new Error("CANCELLED");
    await new Promise((r) => setTimeout(r, interval * 1000));
    const t = await postForm(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT_ID, device_code: dc.deviceCode });
    if (t.access_token) return { access: t.access_token, refresh: t.refresh_token };
    if (t.error === "slow_down") interval += 5;
    else if (t.error && t.error !== "authorization_pending")
      throw new Error("Login abgebrochen: " + (t.error_description || t.error));
  }
  throw new Error("Zeit abgelaufen — der Anmelde-Code wurde nicht bestaetigt.");
}

async function refreshMsa(refreshToken) {
  const t = await postForm(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken, scope: SCOPE });
  if (!t.access_token) {
    // Nur invalid_grant heisst "Token ist wirklich tot" (abgelaufen/widerrufen).
    // Alles andere (Netzwerk, AADSTS-Serverfehler, Throttling) ist voruebergehend.
    const err = new Error("Microsoft-Anmeldung abgelehnt: " + (t.error_description || t.error || "unbekannt").split("\n")[0]);
    err.code = t.error === "invalid_grant" ? "INVALID_GRANT" : "TEMP";
    throw err;
  }
  return { access: t.access_token, refresh: t.refresh_token || refreshToken };
}

// ── MSA -> Minecraft ────────────────────────────────────────────────────────
async function msaToMinecraft(msaAccess) {
  // 1) Xbox Live
  const xbl = (await postJson("https://user.auth.xboxlive.com/user/authenticate", {
    Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msaAccess}` },
    RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT",
  })).json;
  const uhs = xbl?.DisplayClaims?.xui?.[0]?.uhs;
  if (!xbl.Token || !uhs) throw new Error("Xbox-Live-Anmeldung fehlgeschlagen.");

  // 2) XSTS
  const xsts = (await postJson("https://xsts.auth.xboxlive.com/xsts/authorize", {
    Properties: { SandboxId: "RETAIL", UserTokens: [xbl.Token] },
    RelyingParty: "rp://api.minecraftservices.com/", TokenType: "JWT",
  })).json;
  if (!xsts.Token) {
    if (xsts.XErr === 2148916233) throw new Error("Dieses Microsoft-Konto hat kein Xbox-Profil. Bitte mit dem Minecraft-Konto anmelden.");
    if (xsts.XErr === 2148916238) throw new Error("Kinderkonto — muss erst einer Microsoft-Family hinzugefuegt werden.");
    throw new Error("Xbox-Sicherheitstoken (XSTS) fehlgeschlagen.");
  }
  const xuid = xsts?.DisplayClaims?.xui?.[0]?.xid || "";

  // 3) Minecraft-Login
  const mc = await postJson("https://api.minecraftservices.com/authentication/login_with_xbox", {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}` });
  if (mc.status === 403) throw new Error("Die Anmeldung ist bei Mojang noch nicht freigeschaltet.");
  if (mc.status !== 200 || !mc.json.access_token) throw new Error("Minecraft-Anmeldung fehlgeschlagen (HTTP " + mc.status + ").");
  return { mcToken: mc.json.access_token, xuid };
}

async function getProfile(mcToken) {
  const r = await fetch("https://api.minecraftservices.com/minecraft/profile", {
    headers: { Authorization: "Bearer " + mcToken } });
  if (r.status === 404) throw new Error("Dieses Konto besitzt Minecraft: Java Edition nicht.");
  if (!r.ok) {
    const err = new Error("Minecraft-Profil konnte nicht geladen werden (HTTP " + r.status + ").");
    err.status = r.status;
    throw err;
  }
  const p = await r.json();
  return { uuid: p.id, name: p.name };
}

/**
 * Baut aus MSA-Tokens eine komplette Spiel-Session (und persistiert den Refresh-Token).
 * cachedProfile (name+uuid aus dem gespeicherten Konto): Faellt der Mojang-Profil-Server
 * aus (5xx — z.B. Stoerung 18.07.2026), spielen Bestandsnutzer mit dem Cache weiter.
 */
async function buildSession(msa, cachedProfile) {
  const { mcToken, xuid } = await msaToMinecraft(msa.access);
  let prof;
  try {
    prof = await getProfile(mcToken);
  } catch (e) {
    if (cachedProfile && cachedProfile.uuid && (e.status >= 500 || e.status === 429)) prof = cachedProfile;
    else throw e;
  }
  const session = {
    name: prof.name, uuid: prof.uuid, accessToken: mcToken, xuid, userType: "msa",
  };
  saveAccount({ refresh: msa.refresh, name: prof.name, uuid: prof.uuid });
  return session;
}

/** Interaktiver Login. onCode({userCode,verificationUri}) fuer die Anzeige. */
async function login(onCode, shouldCancel) {
  const dc = await requestDeviceCode();
  if (onCode) onCode({ userCode: dc.userCode, verificationUri: dc.verificationUri, expiresIn: dc.expiresIn });
  const msa = await pollForMsa(dc, shouldCancel);
  return buildSession(msa);
}

/**
 * Stiller Login aus gespeichertem Refresh-Token.
 * Gibt Session zurueck, oder null wenn der Token WIRKLICH tot ist (invalid_grant).
 * Bei voruebergehenden Stoerungen (Netzwerk, Microsoft/Xbox/Mojang down) wird
 * geworfen — der gespeicherte Login bleibt dabei ERHALTEN (frueher wurde er
 * hier bei jedem Fehler geloescht -> Massen-Neuanmeldungen bei jeder Stoerung).
 */
async function silentSession() {
  const acc = loadAccount();
  if (!acc || !acc.refresh) return null;
  let msa;
  try {
    msa = await refreshMsa(acc.refresh);
  } catch (e) {
    if (e.code === "INVALID_GRANT") { clearAccount(); return null; }
    throw e;   // voruebergehend -> Konto behalten, Fehler nach oben
  }
  // Microsoft rotiert den Refresh-Token: sofort sichern, damit er auch dann
  // nicht verloren geht, wenn die restliche Kette (Xbox/Mojang) gerade klemmt.
  saveAccount({ refresh: msa.refresh, name: acc.name, uuid: acc.uuid });
  return await buildSession(msa, { name: acc.name, uuid: acc.uuid });
}

/** Nur der Anzeigename aus dem lokalen Cache (ohne Netz), fuer die UI beim Start. */
function cachedAccount() {
  const acc = loadAccount();
  return acc ? { name: acc.name, uuid: acc.uuid } : null;
}

function hasAccount() { return !!(loadAccount() && loadAccount().refresh); }

module.exports = {
  setAccountPath, login, silentSession, cachedAccount, hasAccount,
  logout: clearAccount,
};
