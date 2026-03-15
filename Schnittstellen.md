# Schnittstellen.md — iobroker.mbrepository

Vollständige Dokumentation aller HTTP-Endpunkte des MBRepository Adapters.  
Basis-URL: `http://<iobroker-ip>:8091`

---

## Allgemein

- Alle API-Antworten: `Content-Type: application/json`
- CORS: `Access-Control-Allow-Origin: *` (alle Ursprünge erlaubt)
- Authentifizierung: **keine** (Adapter lauscht intern, kein Auth erforderlich)
- Fehlerformat: `{ "ok": false, "error": "Fehlermeldung" }`

---

## GET /

Liefert das vollständige Web-Interface als HTML.

**Antwort:** `text/html; charset=utf-8`

---

## GET /api/ping

Verbindungstest / Health-Check.

**Antwort:**
```json
{
  "ok": true,
  "adapter": "mbrepository",
  "version": "0.2.0"
}
```

---

## GET /api/repos

Liefert alle zuletzt gescannten Repositories mit vollständigen Metadaten.

**Antwort:**
```json
{
  "ok": true,
  "lastScan": "2026-03-14T10:30:00.000Z",
  "scanning": false,
  "repos": [
    {
      "name": "iobroker.metermaster",
      "adapterName": "metermaster",
      "description": "ioBroker Adapter for the Android APP",
      "url": "https://github.com/MPunktBPunkt/iobroker.metermaster",
      "updatedAt": "2026-03-09T12:00:00Z",
      "stars": 0,
      "defaultBranch": "main",
      "installed": "0.3.1",
      "latestRelease": {
        "tag": "v0.4.0",
        "name": "first release",
        "date": "2026-03-09T10:00:00Z",
        "prerelease": false
      },
      "latestTag": { "name": "v0.4.0" },
      "releases": [
        {
          "tag": "v0.4.0",
          "name": "first release",
          "date": "2026-03-09T10:00:00Z",
          "prerelease": false,
          "body": "Release notes..."
        }
      ],
      "tags": [
        { "name": "v0.4.0", "sha": "a1b2c3d" }
      ]
    }
  ]
}
```

**Feld `scanning`:** `true` während ein Scan läuft – Client soll erneut pollen.  
**Feld `installed`:** `null` wenn der Adapter nicht in `/opt/iobroker/node_modules/` gefunden wurde.  
**Hinweis:** Die Suche nach dem installierten Adapter ist case-insensitiv — `iobroker.MBrepository` und `iobroker.mbrepository` werden beide erkannt.

---

## POST /api/scan

Startet einen GitHub-Scan asynchron. Antwort kommt sofort zurück.  
Ergebnisse per `/api/repos` abrufen (polling bis `scanning: false`).

**Request:** kein Body erforderlich

**Antwort:**
```json
{
  "ok": true,
  "msg": "Scan gestartet"
}
```

**Hinweis:** Parallele Scans werden ignoriert (`scanRunning`-Guard im Adapter).

---

## GET /api/logs

Liefert alle intern gepufferten Adapter-Log-Einträge.

**Antwort:**
```json
{
  "ok": true,
  "logs": [
    {
      "ts": 1741954200000,
      "level": "info",
      "cat": "SYSTEM",
      "msg": "MBRepository Adapter v0.1.0 gestartet — Port: 8091"
    },
    {
      "ts": 1741954203000,
      "level": "info",
      "cat": "SCAN",
      "msg": "4 ioBroker-Repositories gefunden"
    }
  ]
}
```

**Log-Level:** `info` | `warn` | `error` | `debug`  
**Kategorien (cat):** `SYSTEM` | `SCAN` | `INSTALL` | `UPGRADE` | `SELFUPDATE`

---

## GET /api/installlog

Liefert alle Shell-Ausgaben aus Installations-/Upgrade-Vorgängen.

**Antwort:**
```json
{
  "ok": true,
  "log": [
    { "ts": 1741954500000, "line": "[START] Installiere iobroker.kostalpiko..." },
    { "ts": 1741954501000, "line": "[CMD] sudo iobroker add https://github.com/..." },
    { "ts": 1741954510000, "line": "Adapter kostalpiko@0.1.0 installed successfully" },
    { "ts": 1741954511000, "line": "[EXIT] Code: 0" },
    { "ts": 1741954512000, "line": "[SUCCESS] iobroker.kostalpiko installiert" }
  ]
}
```

**Präfixe in `line`:**
| Präfix       | Bedeutung                              |
|--------------|----------------------------------------|
| `[CMD]`      | Ausgeführter Shell-Befehl              |
| `[START]`    | Aktion gestartet (UI-Meldung)          |
| `[SUCCESS]`  | Aktion erfolgreich abgeschlossen       |
| `[FAIL]`     | Aktion fehlgeschlagen                  |
| `[EXIT]`     | Prozess-Exit-Code                      |
| `[STDERR]`   | Stderr-Ausgabe des Prozesses           |
| `[UI]`       | Direkte UI-Rückmeldung                 |
| *(kein Präfix)* | Normale stdout-Zeile des Prozesses  |

---

## POST /api/install

Installiert einen noch nicht installierten Adapter neu.  
Verwendet intern: `sudo iobroker add https://github.com/{user}/{repoName}`

**Request Body:**
```json
{
  "repoName": "iobroker.kostalpiko"
}
```

**Antwort (sofort):**
```json
{
  "ok": true,
  "msg": "Installation gestartet"
}
```

**Fehler:**
```json
{
  "ok": false,
  "error": "Fehlermeldung"
}
```

**Hinweis:** Die eigentliche Installation läuft asynchron im Hintergrund.  
Verlauf via `/api/installlog` verfolgen.

---

## POST /api/upgrade

Führt ein Upgrade oder Downgrade eines installierten Adapters durch.  
Verwendet intern: `sudo iobroker upgrade {adapterName} https://github.com/{user}/{repoName}[#{tag}]`

**Request Body:**
```json
{
  "adapterName": "metermaster",
  "repoName":    "iobroker.metermaster",
  "tag":         "v0.3.0"
}
```

- `tag`: optional – leer oder `null` = neueste Version installieren
- `tag`: gesetzt = exakt diese Version installieren (Downgrade möglich)

**Antwort (sofort):**
```json
{
  "ok": true,
  "msg": "Upgrade gestartet"
}
```

**Verlauf:** via `/api/installlog`  
**Nach Abschluss:** Adapter führt automatisch `/api/scan` aus → `/api/repos` zeigt neue Versionen.

---

## GET /api/version

Vergleicht installierte Version des MBRepository-Adapters mit dem neuesten GitHub-Release.

**Antwort (bei verfügbarem Release):**
```json
{
  "ok": true,
  "installed": "0.1.0",
  "latest": "v0.2.0"
}
```

**Antwort (wenn GitHub nicht erreichbar oder kein Release):**
```json
{
  "ok": false,
  "installed": "0.1.0",
  "error": "Fehlermeldung"
}
```

---

## POST /api/selfupdate

Startet das Self-Update des MBRepository-Adapters.  
Führt aus: `sudo iobroker upgrade mbrepository https://github.com/{user}/iobroker.mbrepository`  
Der Adapter-Prozess beendet sich nach 2s via `process.exit(0)` (ioBroker startet ihn neu).

**Request:** kein Body

**Antwort (sofort):**
```json
{
  "ok": true,
  "msg": "Self-Update gestartet"
}
```

---

## Externe GitHub API (vom Adapter genutzt)

| Endpunkt                                                     | Zweck                        |
|--------------------------------------------------------------|------------------------------|
| `GET /users/{user}/repos?per_page=100&page=N`                | Alle Repos eines Nutzers     |
| `GET /repos/{user}/{repo}/releases?per_page=30`              | Releases eines Repos         |
| `GET /repos/{user}/{repo}/tags?per_page=30`                  | Tags eines Repos             |
| `GET /repos/{user}/{repo}/releases/latest`                   | Neuestes Release (self-update)|

**Rate Limits (ohne Token):** 60 Requests/Stunde pro IP  
**Rate Limits (mit Token):** 5000 Requests/Stunde  

→ Bei vielen Repos (>15) und häufigem Scannen wird ein GitHub Token empfohlen.

---

## ioBroker States

| State                           | Typ     | Beschreibung                            |
|---------------------------------|---------|-----------------------------------------|
| `mbrepository.0.info.connection`| boolean | Adapter verbunden                       |
| `mbrepository.0.info.lastScan`  | string  | ISO-8601 Zeitstempel des letzten Scans  |
| `mbrepository.0.info.reposFound`| number  | Anzahl gefundener iobroker.*-Repos      |

---

## Installationspfade (intern)

| Pfad                                              | Zweck                                         |
|---------------------------------------------------|-----------------------------------------------|
| `/opt/iobroker/node_modules/{repoName}/`          | Installationsverzeichnis jedes Adapters       |
| `/opt/iobroker/node_modules/{repoName}/package.json` | Quelle für `installed`-Version            |

---

## Bekannte Einschränkungen

- GitHub API liefert max. 100 Repos pro Seite → Paginierung ist implementiert
- `iobroker add/upgrade` benötigt Netzwerkzugriff auf GitHub
- Downgrade auf nicht-getaggte Commits nicht unterstützt (nur Tags/Releases)
- Bei privatem GitHub-Token: Token hat nur Lesezugriff nötig (`public_repo` scope)
