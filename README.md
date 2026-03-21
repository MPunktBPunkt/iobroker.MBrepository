# ioBroker MB Repository Manager

[![Version](https://img.shields.io/badge/version-0.5.4-blue.svg)](https://github.com/MPunktBPunkt/iobroker.mbrepository)
[![License](https://img.shields.io/badge/license-GPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg)](https://nodejs.org)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)

Verwalte alle deine ioBroker-Adapter direkt aus GitHub — Scan, Versionsvergleich, Upgrade, Downgrade und Neuinstallation über ein elegantes Web-Interface.

---

## Features

* 🔍 **GitHub-Scanner** – Listet automatisch alle `iobroker.*`-Repositories deines GitHub-Accounts auf
* 📦 **Versionsvergleich** – Zeigt installierte vs. verfügbare Version (semver-korrekt)
* ⬆️ **Upgrade / Downgrade** – Auf beliebigen Release oder Tag aktualisieren
* 🚀 **Latest (main)** – Aktuellen main-Branch direkt installieren ohne Release
* 🖥️ **Debug-Konsole** – Echtzeit Shell-Ausgabe bei Installationen
* 🔄 **Self-Update** – Adapter aktualisiert sich selbst
* 📋 **Log-Viewer** – Adapter-Logs mit Level-Filter und Export

---

## Installation

```bash
iobroker url https://github.com/MPunktBPunkt/iobroker.mbrepository
iobroker add mbrepository
iobroker start mbrepository
```

---

## Update

```bash
iobroker url https://github.com/MPunktBPunkt/iobroker.mbrepository
iobroker restart mbrepository
```

---

## Konfiguration

Im ioBroker Admin unter **Adapter → MB Repository Manager**:

| Einstellung | Standard | Beschreibung |
|---|---|---|
| HTTP Port | `8091` | Port des Web-Interfaces |
| GitHub Benutzername | `MPunktBPunkt` | GitHub-Account der gescannt wird |
| GitHub Token | leer | Optional: 5000 statt 60 API-Anfragen/h |
| Beim Start automatisch scannen | ✅ | GitHub-Scan beim Adapter-Start |
| sudo verwenden | ✅ | `sudo -n` als Fallback |
| Ausführliches Logging | ✅ | Debug-Logs anzeigen |

Web-UI: `http://IP:8091/`

---

## Web-UI

### Tab: Daten

| Toggle | Verhalten |
|---|---|
| **Nur Releases** | Dropdown mit getaggten Releases, Upgrade/Downgrade auf Version |
| **Latest (main)** | Kein Dropdown, direkter Button „🚀 Latest (main) installieren“ |

Status-Badges: ✅ Aktuell · ⬆ Update verfügbar · ⬇ Neuer als GitHub · 🚀 main installierbar

### Tab: Nodes
Releases und Tags des ausgewählten Repositories mit Datum.

### Tab: Logs
Adapter-Logs mit Level-Filter, Auto-Scroll und Export.

### Tab: System
Versions-Check, Self-Update, Neuinstallation nicht installierter Adapter, Installations-Konsole.

---

## Angelegte Datenpunkte

```
mbrepository.0
  info.connection    – Adapter verbunden (boolean)
  info.lastScan      – Zeitpunkt letzter GitHub-Scan (string)
  info.reposFound    – Anzahl gefundener Repositories (number)
```

---

## Hinweise

**GitHub Rate-Limit:** Ohne Token sind nur 60 API-Anfragen/Stunde möglich. Bei vielen Repositories empfiehlt sich ein GitHub Personal Access Token in den Adapter-Einstellungen (5000/h).

**sudo:** Der Adapter läuft als `iobroker`-User und versucht Installationen zuerst ohne sudo. Falls nötig: `sudo visudo` und folgende Zeile ergänzen:
```
iobroker ALL=(ALL) NOPASSWD: /usr/bin/node /opt/iobroker/node_modules/iobroker.js
```

---

## Changelog

### 0.5.4 (2026-03-21)
* Bugfix: GitHub Rate-Limit führte zu Adapter-Absturz (unhandled rejection)

### 0.5.2 (2026-03-21)
* Neu: Toggle "Latest (main)" — installiert main-Branch ohne Release
* Bugfix: GitHub-URL immer lowercase (Exit 25 bei Repos mit Großbuchstaben behoben)

### 0.5.0 (2026-03-18)
* Bugfix: `iobroker url` + `restart` statt `iobroker upgrade` für GitHub-Adapter

### 0.4.0 (2026-03-18)
* Bugfix: JavaScript-Escaping korrigiert (Tabs funktionierten nicht)

### 0.3.0 (2026-03-15)
* Bugfix: `req.abort()` → `req.destroy()`, GitHub API Fehler im UI sichtbar, Auto-Scan

### 0.1.0 (2026-03-14)
* Erstveröffentlichung

---

## Lizenz

GNU General Public License v3.0 © MPunktBPunkt — siehe [LICENSE](LICENSE)

[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)
