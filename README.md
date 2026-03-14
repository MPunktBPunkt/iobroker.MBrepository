# ioBroker MB Repository Manager

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/MPunktBPunkt/iobroker.mbrepository)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg)](https://nodejs.org)

Verwalte alle deine ioBroker-Adapter direkt aus GitHub — Scan, Versionsvergleich, Upgrade, Downgrade und Neuinstallation über ein elegantes Web-Interface.

---

## Features

* 🔍 **GitHub-Scanner** – Listet automatisch alle `iobroker.*`-Repositories von deinem GitHub-Account auf
* 📦 **Versionsvergleich** – Zeigt installierte vs. verfügbare Version für jeden Adapter
* ⬆️ **Upgrade / Downgrade** – Wähle gezielt eine Release-Version oder Tag und installiere sie mit einem Klick
* 🚀 **Neuinstallation** – Installiere noch nicht vorhandene Adapter direkt aus GitHub (mit sudo)
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

### Option B – manuell (ohne Internet / Offline)

```bash
# 1. Ordner anlegen
mkdir -p /opt/iobroker/node_modules/iobroker.mbrepository

# 2. Dateien kopieren (USB, SCP, WinSCP …)
#    Benötigte Dateien: main.js  io-package.json  package.json

# 3. Abhängigkeiten installieren
cd /opt/iobroker/node_modules/iobroker.mbrepository
npm install

# 4. Adapter registrieren
cd /opt/iobroker
iobroker add mbrepository
```

### Adapter starten

```bash
iobroker start mbrepository
```

Web-UI im Browser öffnen:
```
http://IP-DES-IOBROKER-SERVERS:8091/
```

---

## Konfiguration

Im ioBroker Admin unter **Adapter → MB Repository Manager** konfigurieren:

| Einstellung               | Standard         | Beschreibung                                        |
|---------------------------|------------------|-----------------------------------------------------|
| HTTP Port                 | `8091`           | Port des Web-Interfaces                             |
| GitHub Benutzername       | `MPunktBPunkt`   | GitHub-Account der gescannt wird                    |
| GitHub Token              | leer             | Optional: für höhere API-Limits (5000 statt 60/h)   |
| Beim Start automatisch scannen | ✅          | GitHub-Scan beim Adapter-Start ausführen            |
| sudo verwenden            | ✅               | `sudo` vor iobroker-Befehlen (für Installation)     |
| Ausführliches Logging     | ✅               | Debug-Logs anzeigen                                 |
| Log-Puffer                | `500`            | Max. gepufferte Log-Einträge                        |

### sudo-Rechte konfigurieren

Damit der Adapter Adapter installieren und upgraden kann, muss der `iobroker`-User sudo-Rechte für iobroker-Befehle haben:

```bash
sudo visudo
```

Folgende Zeile hinzufügen:
```
iobroker ALL=(ALL) NOPASSWD: /usr/bin/iobroker, /usr/local/bin/iobroker
```

### Firewall (falls nötig)

```bash
sudo ufw allow 8091/tcp
```

---

## Web-UI

### Tab: Daten

Die Hauptübersicht aller `iobroker.*`-Repositories:

| Element | Beschreibung |
|---------|--------------|
| **GitHub scannen** | Lädt alle Repos von GitHub, erkennt installierte Versionen |
| **Nur Releases / Alle Tags** | Umschalter: welche Versionen in den Auswahlmenüs erscheinen |
| **Repo-Karte** | Name, Beschreibung, installierte Version, neueste Version |
| **Statusbadge** | ✓ Aktuell / ↑ Update verfügbar / nicht installiert |
| **Versions-Auswahl** | Dropdown mit allen verfügbaren Releases oder Tags |
| **Upgrade / Downgrade** | Installiert die gewählte Version (leer = neueste) |
| **Installieren** | Erscheint nur bei nicht-installierten Adaptern |

### Tab: Nodes

Detailansicht eines gewählten Repositories:

- Alle **Releases** mit Datum und Prerelease-Kennzeichnung
- Alle **Tags** mit Commit-Hash

### Tab: Logs

Interne Adapter-Logs mit:

- Filter nach Level (Info / Warnung / Fehler / Debug)
- Auto-Scroll
- Export als `.txt`-Datei

Farbkodierung: 🔴 Fehler · 🟡 Warnung · 🔵 Info · ⬜ Debug · 🟢 System

### Tab: System

- **Adapter-Info**: Installierte vs. GitHub-Version, letzter Scan, Repo-Anzahl
- **Auf Updates prüfen**: Vergleicht aktuell installierte Version mit GitHub
- **Update installieren**: Erscheint wenn neue Version verfügbar
- **Neuen Adapter installieren**: Dropdown mit allen nicht-installierten Adaptern
- **Installations-Konsole**: Echtzeit-Ausgabe aller Shell-Befehle

---

## Angelegte Datenpunkte

Nach dem Start erscheinen unter `mbrepository.0`:

```
mbrepository.0
  info.connection    – Adapter verbunden (boolean)
  info.lastScan      – Zeitpunkt letzter GitHub-Scan (string)
  info.reposFound    – Anzahl gefundener iobroker.*-Repos (number)
```

---

## HTTP API

### Verbindungstest

```
GET http://host:8091/api/ping
→ { "ok": true, "adapter": "mbrepository", "version": "0.1.0" }
```

### Repositories abrufen

```
GET http://host:8091/api/repos
→ { "ok": true, "repos": [...], "lastScan": "...", "scanning": false }
```

### Scan starten

```
POST http://host:8091/api/scan
→ { "ok": true, "msg": "Scan gestartet" }
```

### Adapter installieren

```
POST http://host:8091/api/install
Content-Type: application/json

{ "repoName": "iobroker.kostalpiko" }
→ { "ok": true, "msg": "Installation gestartet" }
```

### Upgrade / Downgrade

```
POST http://host:8091/api/upgrade
Content-Type: application/json

{
  "adapterName": "metermaster",
  "repoName":    "iobroker.metermaster",
  "tag":         "v0.3.0"
}
→ { "ok": true, "msg": "Upgrade gestartet" }
```

Vollständige API-Dokumentation in [Schnittstellen.md](Schnittstellen.md).

---

## Update

### Option A – über das Web-UI (empfohlen)

Browser `http://IP:8091/` → Tab **⚙️ System** → **„Auf Updates prüfen"**  
Bei verfügbarem Update: **„Update installieren"** klicken.

### Option B – Kommandozeile

```bash
iobroker upgrade mbrepository https://github.com/MPunktBPunkt/iobroker.mbrepository
iobroker restart mbrepository
```

---

## Changelog

### 0.1.0 (2026-03-14)

* Erstveröffentlichung
* GitHub-Scanner für alle `iobroker.*`-Repositories
* Versionsvergleich: installiert vs. GitHub-Release
* Upgrade und Downgrade auf beliebige Tag-Version
* Neuinstallation nicht vorhandener Adapter (mit sudo)
* Umschalter: nur Releases oder alle Tags
* Debug-Konsole mit Shell-Ausgabe in Echtzeit
* Self-Update via GitHub Releases API
* Log-Viewer mit Filter und Export
* ioBroker States: connection, lastScan, reposFound

---

## Lizenz

MIT © MPunktBPunkt
