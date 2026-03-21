# ioBroker MB Repository Manager

[![Version](https://img.shields.io/badge/version-0.5.4-blue.svg)](https://github.com/MPunktBPunkt/iobroker.mbrepository)
[![License](https://img.shields.io/badge/license-GPL%20v3-blue.svg)](LICENSE)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg)](https://nodejs.org)

Verwalte alle deine ioBroker-Adapter direkt aus GitHub — Scan, Versionsvergleich, Upgrade, Downgrade und Neuinstallation über ein elegantes Web-Interface.

---

## Features

* 🔍 **GitHub-Scanner** – Listet automatisch alle `iobroker.*`-Repositories von deinem GitHub-Account auf
* 📦 **Versionsvergleich** – Zeigt installierte vs. verfügbare Version für jeden Adapter (semver-korrekt)
* ⬆️ **Upgrade / Downgrade** – Wähle gezielt eine Release-Version oder Tag und installiere sie mit einem Klick
* 🚀 **Neuinstallation** – Installiere noch nicht vorhandene Adapter direkt aus GitHub
* 🔀 **Releases oder Tags** – Umschalter zwischen "nur getaggte Releases" und "alle Tags"
* 🖥️ **Debug-Konsole** – Echtzeit-Ausgabe des Installations-Verlaufs direkt aus der Linux-Shell
* 🔄 **Self-Update** – MBRepository aktualisiert sich selbst aus GitHub
* 📋 **Log-Viewer** – Interne Adapter-Logs mit Level-Filter und Export

---

## Installation

### Option A – direkt von GitHub (empfohlen)

```bash
iobroker add https://github.com/MPunktBPunkt/iobroker.mbrepository
```

### Option B – manuell

```bash
mkdir -p /opt/iobroker/node_modules/iobroker.mbrepository
# Dateien kopieren: main.js  io-package.json  package.json
cd /opt/iobroker/node_modules/iobroker.mbrepository
npm install
cd /opt/iobroker
iobroker add mbrepository
iobroker start mbrepository
```

Web-UI: `http://IP:8091/`

---

## Konfiguration

| Einstellung | Standard | Beschreibung |
|---|---|---|
| HTTP Port | `8091` | Port des Web-Interfaces |
| GitHub Benutzername | `MPunktBPunkt` | GitHub-Account der gescannt wird |
| GitHub Token | leer | Optional: für höhere API-Limits (5000 statt 60/h) |
| Beim Start automatisch scannen | ✅ | GitHub-Scan beim Adapter-Start ausführen |
| sudo verwenden | ✅ | `sudo -n` als Fallback wenn nötig |
| Ausführliches Logging | ✅ | Debug-Logs anzeigen |
| Log-Puffer | `500` | Max. gepufferte Log-Einträge |

### Kommandoausführung

Der Adapter läuft als `iobroker`-User und versucht immer erst **ohne sudo**:

```
node /opt/iobroker/node_modules/iobroker.js add <url>
```

Falls das fehlschlägt, wird `sudo -n` versucht. Für NOPASSWD:

```bash
sudo visudo
# Folgende Zeile ergänzen:
iobroker ALL=(ALL) NOPASSWD: /usr/bin/node /opt/iobroker/node_modules/iobroker.js
```

---

## Web-UI Tabs

| Tab | Inhalt |
|---|---|
| **Daten** | Repo-Liste, Scan, Toggle Releases/Tags, Status-Badges, Upgrade/Downgrade |
| **Nodes** | Releases & Tags des ausgewählten Repos |
| **Logs** | Adapter-Logs mit Level-Filter, Auto-Scroll, Export |
| **System** | Versions-Check, Self-Update, Neu-Installation, Installations-Konsole |

### Status-Badges

| Badge | Bedeutung |
|---|---|
| ✅ Aktuell (grün) | Installierte Version = GitHub-Version |
| ⬆ Update verfügbar (orange) | Neuere Version auf GitHub |
| ⬇ Neuer als GitHub (blau) | Lokal neuer als letzter GitHub-Release |
| nicht installiert (grau) | Nicht in node_modules gefunden |

---

## Angelegte Datenpunkte

```
mbrepository.0
  info.connection    – Adapter verbunden (boolean)
  info.lastScan      – Zeitpunkt letzter GitHub-Scan (string)
  info.reposFound    – Anzahl gefundener iobroker.*-Repos (number)
```

---

## Update

```bash
# Über Web-UI: http://IP:8091/ -> System -> Auf Updates prüfen
# Oder:
iobroker upgrade mbrepository https://github.com/MPunktBPunkt/iobroker.mbrepository
iobroker restart mbrepository
```

---

## Changelog

### 0.5.4 (2026-03-21)
* **Bugfix:** GitHub Rate-Limit verursachte `UNCAUGHT_EXCEPTION` → Adapter-Absturz
* **Fix 1:** Auto-Scan beim Start hat jetzt `.catch()` — kein unhandled rejection mehr
* **Fix 2:** `scanRepositories()` wirft keine Exception mehr nach außen — gibt leeres Array zurück
* **Fix 3:** Globaler `unhandledRejection`-Handler als letztes Sicherheitsnetz
* **Fix 4:** Rate-Limit-URL aus Log-Meldungen entfernt (kürzere, lesbare Logs)
* **Tipp:** GitHub Token in den Einstellungen hinterlegen → 5000 statt 60 Anfragen/h

### 0.5.3 (2026-03-21)
* Lizenz auf **GPL v3** geändert (war MIT)
* Spendenbutton (PayPal) in README eingefügt

### 0.5.2 (2026-03-21)
* **Neu:** Toggle "Alle Tags" → **"Latest (main)"** — installiert den aktuellen main-Branch direkt ohne Release
* Im Latest-Modus: kein Versions-Dropdown, direkt ein-Klick "&#128640; Latest (main) installieren"
* Versionzeile zeigt "Ziel: main" statt einer Versionsnummer
* Server: `forceLatest`-Flag überspringt Tag-Anhang in der GitHub-URL

### 0.5.1 (2026-03-18)
* **Bugfix:** GitHub-URL bei Install/Upgrade immer lowercase — `iobroker.FritzWireguard` → `iobroker.fritzwireguard` (Exit 25 behoben)
* **Bugfix:** Rate-Limit-Fehlermeldung ohne langen Docs-URL

### 0.5.0 (2026-03-18)
* **Bugfix root cause:** `iobroker upgrade <name> <url>` funktioniert nur für Adapter im offiziellen Repository → Exit 53
* **Fix Upgrade:** `iobroker url <url>` + `iobroker restart <name>`
* **Fix Neuinstallation:** `iobroker url <url>` + `iobroker add <name>` + `iobroker start <name>`
* **Fix Self-Update:** gleiche Korrektur
* Konsole zeigt jetzt jeden Schritt einzeln: `[STEP 1/2]`, `[STEP 2/2]`

### 0.4.0 (2026-03-18)
* **Bugfix:** JS-Escaping in `init()` und `showScanError()` korrigiert — `"` in single-quoted Node.js-Strings erzeugte ungültiges Browser-JS → alle Tabs funktionierten nicht
* Browser-JS wird jetzt zusätzlich via `vm.Script` auf gültiges Syntax geprüft

### 0.3.0 (2026-03-15)
* **Bugfix:** `req.abort()` durch `req.destroy()` ersetzt (deprecated in Node.js 14+, Ursache für stille Scan-Fehler)
* **Bugfix:** GitHub API-Fehler (Rate-Limit, Auth, Not Found) werden jetzt erkannt und im UI angezeigt statt zu 0 Repos führen
* **Neu:** Sichtbare Fehlermeldung im Daten-Tab wenn Scan scheitert (mit Tipp zum GitHub-Token)
* **Neu:** Automatischer Scan beim Seitenaufruf wenn noch keine Repos geladen sind
* **Neu:** Lade-Animation während Scan läuft

### 0.2.0 (2026-03-15)
* **Bugfix:** Groß-/Kleinschreibung bei Adaptererkennung — `iobroker.MBrepository` wird jetzt korrekt als installiert erkannt (case-insensitive Suche in `node_modules`)
* **Bugfix:** Semver-Vergleich korrigiert — `0.6.0 > v0.5.0` zeigt jetzt "⬇ Neuer als GitHub" statt "Update verfügbar"
* **Neu:** Badge "⬇ Neuer als GitHub" (blau) wenn lokale Version neuer als GitHub-Release
* **Bugfix:** sudo-Fallback nur bei echten Berechtigungsfehlern (nicht mehr bei jedem EXIT:1)
* **Bugfix:** iobroker-Befehl via `node iobroker.js` statt Shell-Wrapper (behebt "Syntax error: word unexpected")
* **Verbessert:** Kontrast aller Badges und Toggle-Buttons deutlich erhöht
* **Fix:** Ungenutzten `spawn`-Import entfernt

### 0.1.0 (2026-03-14)
* Erstveröffentlichung: GitHub-Scanner, Versionsvergleich, Upgrade/Downgrade, Neuinstallation, Debug-Konsole, Log-Viewer, Self-Update

---

## Lizenz

GNU General Public License v3.0 © MPunktBPunkt

Siehe [LICENSE](LICENSE) für Details.

---

## Spenden

[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)
