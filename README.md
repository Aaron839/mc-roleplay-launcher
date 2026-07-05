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

- **Kein Passwort.** Der Launcher fragt dich **nie** nach deinem Minecraft- oder
  Microsoft-Passwort. Der Login läuft über den **offiziellen** Minecraft
  Launcher — unser Client startet ihn nur.
- **Keine Telemetrie, kein Tracking, kein Konto bei uns.** Der Client sendet
  keine personenbezogenen Daten an uns.
- **Alles, was der Launcher aus dem Netz lädt**, kommt aus offiziellen Quellen:

  | Ziel | Wofür |
  |------|-------|
  | `mc-roleplay.de` | unser Modpack (Verweisliste + eigene Mods) |
  | `github.com` | Updates des Launchers selbst |
  | `modrinth.com`, `curseforge.com` | Fremd-Mods (direkt von den Autoren) |
  | `maven.minecraftforge.net` | der Forge-Installer |
  | `adoptium.net` | Java-Laufzeit (falls nicht vorhanden) |
  | Mojang-Server | Vanilla-Minecraft (über den offiziellen Launcher) |
  | `mc-roleplay.net` | reine Server-Status-Abfrage (online? wie viele Spieler?) |

Du kannst das im Code nachvollziehen — alle Netzwerkzugriffe stehen in
[`src/main.js`](src/main.js).

## Was er beim Klick auf „Spielen" tut

1. Sucht eine passende Java-Version (oder lädt Java 17 von Adoptium).
2. Synchronisiert das Modpack von `mc-roleplay.de` (nur geänderte Dateien).
3. Installiert Forge 1.20.1, falls nötig.
4. Legt ein Profil im offiziellen Minecraft Launcher an (mit passendem RAM).
5. Startet den offiziellen Minecraft Launcher — dort loggst du dich wie gewohnt ein.

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
