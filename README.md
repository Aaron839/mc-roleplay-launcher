# MC-ROLEPLAY.DE Launcher

Der offizielle, quelloffene Client für den deutschen Minecraft-Roleplay-Server
**[mc-roleplay.de](https://mc-roleplay.de)**. Er installiert und aktualisiert
unser Modpack automatisch und startet Minecraft — du musst nichts von Hand
einrichten.

> **Herunterladen:** [neueste Version](https://github.com/Aaron839/mc-roleplay-launcher/releases/latest)
> · Windows 10/11 (64-Bit)

---

## Warum ist der Code offen?

Ein Launcher ist Software, die auf deinem PC läuft — du sollst dich nicht auf
ein Versprechen verlassen müssen, sondern **selbst nachsehen können**, was er
tut. Genau dafür ist dieses Repository da: Der komplette Client-Code liegt hier
offen. Wer will, liest ihn selbst oder lässt ihn von jemandem prüfen, dem er
vertraut.

## Was der Launcher mit deinen Daten macht: nichts

- **Kein Passwort.** Der Launcher fragt dich **nie** nach deinem Passwort. Die
  Anmeldung läuft **direkt bei Microsoft** (offizieller Device-Code-Flow): Du
  bestätigst einen Code auf `microsoft.com/link` — dein Passwort tippst du nur
  bei Microsoft ein, nie bei uns. Unsere Server sind daran **nicht beteiligt**
  und sehen weder Passwort noch Tokens. Der Code dazu steht offen in
  [`src/auth.js`](src/auth.js).
- **Token-Speicherung:** Damit du nicht bei jedem Start neu bestätigen musst,
  speichert der Launcher einen Microsoft-Refresh-Token **lokal auf deinem PC**,
  verschlüsselt mit Windows-Bordmitteln (DPAPI via Electron `safeStorage`).
  Er verlässt deinen Rechner nur Richtung Microsoft/Mojang. „Abmelden" löscht ihn.
- **Kein Tracking, kein Konto bei uns.** Der Client verfolgt dich nicht und legt
  kein Nutzerprofil an.
- **Eine Ausnahme, ehrlich gesagt:** Wenn *Minecraft abstürzt*, wird der
  Crash-Report automatisch an unseren Server gesendet, damit wir den Fehler
  beheben können. Er enthält Fehlerdaten, die Mod-Liste und Systeminfos (und den
  im Absturzprotokoll stehenden Minecraft-Namen) — **keine Passwörter**.
  Session-Tokens und Konto-IDs (`--accessToken`, `--clientId`, `--xuid` sowie
  JWTs) werden **vor dem Senden aus dem Report entfernt** (`redactSecrets`). Das
  lässt sich in den Einstellungen mit einem Klick abschalten. Der Code dazu steht
  offen in [`src/main.js`](src/main.js) (`reportNewCrashes`).
- **Alles, was der Launcher aus dem Netz lädt**, kommt aus offiziellen Quellen:

  | Ziel | Wofür |
  |------|-------|
  | `mc-roleplay.de` | unser Modpack (Verweisliste + eigene Mods) |
  | `github.com` | Updates des Launchers selbst |
  | `modrinth.com`, `curseforge.com` | Fremd-Mods (direkt von den Autoren) |
  | `maven.minecraftforge.net` | der Forge-Installer |
  | `adoptium.net` | Java-Laufzeit (falls nicht vorhanden) |
  | `login.microsoftonline.com`, `*.xboxlive.com`, `api.minecraftservices.com` | Microsoft-/Minecraft-Anmeldung (offizieller Weg, direkt — ohne Umweg über uns) |
  | `mc-roleplay.net` | reine Server-Status-Abfrage (online? wie viele Spieler?) |

Du kannst das im Code nachvollziehen — alle Netzwerkzugriffe stehen in
[`src/main.js`](src/main.js).

## Was er beim Klick auf „Spielen" tut

1. Meldet dich still bei Microsoft an (gespeicherter Token — beim ersten Mal einmalig per Code).
2. Sucht eine passende Java-Version (oder lädt Java 17 von Adoptium).
3. Synchronisiert das Modpack von `mc-roleplay.de` (nur geänderte Dateien).
4. Installiert Forge 1.20.1, falls nötig.
5. **Startet Minecraft direkt** — der offizielle Minecraft Launcher wird nicht mehr gebraucht.
   (Nur auf einem ganz frischen PC ohne Vanilla-Dateien fällt er einmalig auf den
   offiziellen Launcher zurück, der sie herunterlädt.)

## Selbst bauen

Voraussetzung: [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start        # Launcher im Entwicklungsmodus starten
npm run dist     # Windows-Installer (.exe) bauen -> dist/
```

Der so gebaute Client ist funktionsgleich mit dem Release. (Eine bitgenaue
Reproduzierbarkeit garantiert erst eine signierte Build-Kette — daran arbeiten wir.)

## Technik

Electron. `src/main.js` = Hauptprozess (die ganze Logik: Java-Suche,
Modpack-Sync via [packwiz](https://packwiz.infra.link/), Forge-Installation,
Profil, Auto-Update). `src/preload.js` = sichere Brücke zur Oberfläche.
`src/renderer/` = Oberfläche (kein Framework, reines HTML/CSS/JS).
Auto-Update über GitHub-Releases (electron-updater).

## Lizenz & Danksagung

Dieser Client steht unter der [MIT-Lizenz](LICENSE). Der Name „MC-ROLEPLAY.DE",
das Logo und die Marke gehören mc-roleplay.de.

Mitgelieferte Komponenten Dritter:
- [packwiz-installer](https://github.com/packwiz/packwiz-installer) (comp500) — MIT, für den Modpack-Sync
- Schriften [Inter](https://rsms.me/inter/), [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) und [VT323](https://fonts.google.com/specimen/VT323) — SIL Open Font License

## Fragen?

[Discord](https://discord.gg/9UVvu5wwfV)
