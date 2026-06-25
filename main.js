'use strict';

const { Adapter } = require('@iobroker/adapter-core');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { exec }        = require('child_process');

const IOBROKER_MODULES = '/opt/iobroker/node_modules';

class MBRepository extends Adapter {
    constructor(options) {
        super({ ...options, name: 'mbrepository' });
        this.httpServer  = null;
        this.logs        = [];
        this.installLog  = [];
        this.repos       = [];
        this.lastScan    = null;
        this.scanRunning  = false;
        this.lastScanError= null;
        this.pack         = null;

        this.on('ready',  this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── Logging ────────────────────────────────────────────────────────────

    addLog(level, cat, msg) {
        const entry = { ts: Date.now(), level, cat, msg };
        this.logs.push(entry);
        if (this.logs.length > (this.config.logBuffer || 500)) this.logs.shift();
        if (level === 'error') this.log.error('[' + cat + '] ' + msg);
        else if (level === 'warn')  this.log.warn('[' + cat + '] ' + msg);
        else if (level === 'debug' && this.config.verboseLogging) this.log.debug('[' + cat + '] ' + msg);
        else if (level !== 'debug') this.log.info('[' + cat + '] ' + msg);
    }

    addInstallLog(line) {
        this.installLog.push({ ts: Date.now(), line: String(line) });
        if (this.installLog.length > 2000) this.installLog.shift();
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    async onReady() {
        try {
            const pkgPath = path.join(__dirname, 'package.json');
            this.pack = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch (e) {
            this.pack = { version: '0.0.0' };
        }

        const port = this.config.port || 8091;
        this.addLog('info', 'SYSTEM', 'MBRepository Adapter v' + this.pack.version + ' gestartet \u2014 Port: ' + port);

        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false },
            native: {}
        });
        await this.setObjectNotExistsAsync('info.lastScan', {
            type: 'state',
            common: { name: 'Last Scan', type: 'string', role: 'value', read: true, write: false },
            native: {}
        });
        await this.setObjectNotExistsAsync('info.reposFound', {
            type: 'state',
            common: { name: 'Repositories Found', type: 'number', role: 'value', read: true, write: false },
            native: {}
        });

        await this.setState('info.connection', true, true);
        this.startHttpServer(port);

        if (this.config.autoScanOnStart !== false) {
            setTimeout(() => {
                this.scanRepositories().catch(e => {
                    this.addLog('warn', 'SCAN', 'Auto-Scan fehlgeschlagen: ' + e.message);
                });
            }, 3000);
        }
    }

    async onUnload(callback) {
        try {
            if (this.httpServer) this.httpServer.close();
            await this.setState('info.connection', false, true);
        } catch (e) { /* ignore */ }
        callback();
    }

    // ─── GitHub API ─────────────────────────────────────────────────────────

    fetchJson(url) {
        return new Promise((resolve, reject) => {
            const opts = {
                headers: {
                    'User-Agent': 'iobroker-mbrepository/' + (this.pack ? this.pack.version : '0.0.0')
                }
            };
            if (this.config.githubToken) {
                opts.headers['Authorization'] = 'token ' + this.config.githubToken;
            }
            const req = https.get(url, opts, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        // GitHub API gibt bei Fehlern { message: '...', documentation_url: '...' }
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.message) {
                            reject(new Error('GitHub API: ' + parsed.message +
                                (parsed.documentation_url ? ' (' + parsed.documentation_url + ')' : '')));
                        } else if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error('GitHub HTTP ' + res.statusCode + ': ' + JSON.stringify(parsed).substring(0, 200)));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        reject(new Error('JSON parse error (HTTP ' + res.statusCode + '): ' + data.substring(0, 200)));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout nach 15s')); });
        });
    }

    async scanRepositories() {
        if (this.scanRunning) {
            this.addLog('warn', 'SCAN', 'Scan bereits aktiv, \u00fcberspringe.');
            return this.repos;
        }
        this.scanRunning  = true;
        this.lastScanError = null;
        const ghUser = this.config.githubUser || 'MPunktBPunkt';
        this.addLog('info', 'SCAN', 'GitHub-Repositories werden gescannt (' + ghUser + ')...');

        try {
            let allRepos = [];
            let page = 1;
            while (true) {
                const batch = await this.fetchJson(
                    'https://api.github.com/users/' + ghUser + '/repos?per_page=100&page=' + page
                );
                if (!Array.isArray(batch) || batch.length === 0) break;
                allRepos = allRepos.concat(batch);
                if (batch.length < 100) break;
                page++;
            }

            const ioRepos = allRepos.filter(r =>
                r.name.toLowerCase().startsWith('iobroker.')
            );
            this.addLog('info', 'SCAN', ioRepos.length + ' ioBroker-Repositories gefunden');

            const enriched = [];
            for (const repo of ioRepos) {
                let releases = [], tags = [];
                try {
                    releases = await this.fetchJson(
                        'https://api.github.com/repos/' + ghUser + '/' + repo.name + '/releases?per_page=30'
                    );
                    if (!Array.isArray(releases)) releases = [];
                } catch (e) { releases = []; }

                try {
                    tags = await this.fetchJson(
                        'https://api.github.com/repos/' + ghUser + '/' + repo.name + '/tags?per_page=30'
                    );
                    if (!Array.isArray(tags)) tags = [];
                } catch (e) { tags = []; }

                const installedVersion = this.getInstalledVersion(repo.name);
                const latestRelease = releases.length > 0 ? releases[0] : null;
                const latestTag     = tags.length > 0 ? tags[0] : null;

                enriched.push({
                    name:          repo.name,
                    adapterName:   repo.name.replace(/^iobroker\./i, ''),
                    description:   repo.description || '',
                    url:           repo.html_url,
                    updatedAt:     repo.updated_at,
                    stars:         repo.stargazers_count || 0,
                    defaultBranch: repo.default_branch || 'main',
                    installed:     installedVersion,
                    latestRelease: latestRelease
                        ? { tag: latestRelease.tag_name, name: latestRelease.name, date: latestRelease.published_at, prerelease: latestRelease.prerelease }
                        : null,
                    latestTag: latestTag
                        ? { name: latestTag.name }
                        : null,
                    releases: releases.map(r => ({
                        tag:        r.tag_name,
                        name:       r.name,
                        date:       r.published_at,
                        prerelease: r.prerelease,
                        body:       (r.body || '').substring(0, 300)
                    })),
                    tags: tags.map(t => ({
                        name: t.name,
                        sha:  (t.commit && t.commit.sha) ? t.commit.sha.substring(0, 7) : ''
                    }))
                });
            }

            this.repos    = enriched;
            this.lastScan = new Date().toISOString();

            await this.setState('info.lastScan', this.lastScan, true);
            await this.setState('info.reposFound', enriched.length, true);
            this.addLog('info', 'SCAN', 'Scan abgeschlossen: ' + enriched.length + ' Repositories');

            return enriched;
        } catch (e) {
            this.lastScanError = e.message;
            // URL aus GitHub-Fehlermeldung entfernen (bessere Log-Lesbarkeit)
            const cleanMsg = e.message.replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();
            this.addLog('error', 'SCAN', 'Fehler beim Scannen: ' + cleanMsg);
            // Kein throw — verhindert unhandled promise rejection und Adapter-Absturz
            return [];
        } finally {
            this.scanRunning = false;
        }
    }

    getInstalledVersion(repoName) {
        // Versuche verschiedene Schreibweisen: original, lowercase, uppercase-ersten-Buchstaben
        const variants = [
            repoName,
            repoName.toLowerCase(),
            repoName.charAt(0).toUpperCase() + repoName.slice(1),
            // iobroker.MBrepository -> iobroker.mbrepository etc.
            repoName.replace(/\.(.)/,  (_, c) => '.' + c.toUpperCase()),
        ];
        for (const name of variants) {
            try {
                const pkgPath = path.join(IOBROKER_MODULES, name, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    if (pkg.version) return pkg.version;
                }
            } catch (e) { /* ignore */ }
        }
        // Noch robuster: alle Ordner in node_modules durchsuchen (case-insensitive)
        try {
            const lowerName = repoName.toLowerCase();
            const entries = fs.readdirSync(IOBROKER_MODULES);
            for (const entry of entries) {
                if (entry.toLowerCase() === lowerName) {
                    const pkgPath = path.join(IOBROKER_MODULES, entry, 'package.json');
                    if (fs.existsSync(pkgPath)) {
                        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                        if (pkg.version) return pkg.version;
                    }
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Baut den korrekten node-basierten iobroker-Aufruf.
    // Das .bin/iobroker ist ein Shell-Wrapper – exec() kann ihn nicht direkt starten.
    // Zuverlaessig ist immer: node <iobroker.js> <args>
    findIobCmd() {
        const iobrokerJs = '/opt/iobroker/node_modules/iobroker.js';
        const nodeExec   = process.execPath; // der laufende node-Prozess
        if (fs.existsSync(iobrokerJs)) {
            return { cmd: '"' + nodeExec + '" "' + iobrokerJs + '"', type: 'node-direct' };
        }
        const candidates = ['/usr/local/bin/iobroker', '/usr/bin/iobroker'];
        for (const p of candidates) {
            try { if (fs.existsSync(p)) return { cmd: p, type: 'system-bin' }; } catch (e) { /* */ }
        }
        // letzter Fallback: node_modules iobroker.js via bash
        const nodeJs = '/opt/iobroker/node_modules/iobroker.js';
        return { cmd: '"' + process.execPath + '" "' + nodeJs + '"', type: 'bash-fallback' };
    }

    // Baut den Befehl mit oder ohne sudo -n
    buildCmd(iobArgs) {
        const { cmd, type } = this.findIobCmd();
        const base    = cmd + ' ' + iobArgs;
        // sudo -n = non-interactive: schlaegt sofort fehl wenn Passwort noetig
        const sudoCmd = 'sudo -n ' + base;
        this.addInstallLog('[INFO] Befehlstyp: ' + type + ' | ' + cmd);
        return { base, sudoCmd };
    }

    runRaw(cmd) {
        return new Promise((resolve, reject) => {
            this.addInstallLog('[CMD] ' + cmd);
            const proc = exec(cmd, {
                cwd: '/opt/iobroker',
                env: { ...process.env, HOME: '/opt/iobroker' },
                maxBuffer: 10 * 1024 * 1024
            });
            let stderrBuf = '';
            proc.stdout.on('data', data => {
                String(data).split('\n').filter(l => l.trim()).forEach(line => {
                    this.addInstallLog(line);
                });
            });
            proc.stderr.on('data', data => {
                stderrBuf += data;
                String(data).split('\n').filter(l => l.trim()).forEach(line => {
                    this.addInstallLog('[STDERR] ' + line);
                });
            });
            proc.on('close', code => {
                this.addInstallLog('[EXIT] Code: ' + code);
                if (code === 0) {
                    resolve(code);
                } else {
                    reject(new Error('EXIT:' + code + '|STDERR:' + stderrBuf.trim()));
                }
            });
            proc.on('error', err => {
                this.addInstallLog('[ERROR] ' + err.message);
                reject(err);
            });
        });
    }

    isSudoPasswordError(errMsg) {
        return errMsg.includes('password is required') ||
               errMsg.includes('terminal is required') ||
               errMsg.includes('no tty present') ||
               errMsg.includes('askpass');
    }

    // Hauptmethode: versucht erst ohne sudo, dann mit sudo -n, gibt klare Hinweise
    async runCommand(iobArgs) {
        const { base, sudoCmd } = this.buildCmd(iobArgs);
        const useSudo = this.config.useSudo !== false;

        // Versuch 1: direkt (iobroker läuft als iobroker-User → eigene node_modules)
        this.addInstallLog('[INFO] Versuche ohne sudo: ' + base);
        try {
            await this.runRaw(base);
            return;
        } catch (e1) {
            const msg1 = e1.message || '';
            // Nur bei klaren Berechtigungsfehlern sudo versuchen — EXIT:1 allein reicht nicht
            const isPermError = msg1.includes('EACCES') ||
                                msg1.includes('permission denied') ||
                                msg1.includes('EPERM')  ||
                                msg1.includes('EXIT:127'); // command not found
            if (!isPermError) {
                // Echter Fehler (npm-Error, Netzwerk etc.) — sudo hilft hier nicht
                throw e1;
            }
            this.addInstallLog('[INFO] Berechtigungsfehler ohne sudo, versuche sudo -n ...');
        }

        // Versuch 2: sudo -n (non-interactive)
        if (useSudo) {
            try {
                await this.runRaw(sudoCmd);
                return;
            } catch (e2) {
                const msg2 = e2.message || '';
                if (this.isSudoPasswordError(msg2)) {
                    // Sudo braucht Passwort → klare Hilfe ausgeben
                    this.addInstallLog('[FAIL] sudo benötigt ein Passwort (kein Terminal verfügbar).');
                    this.addInstallLog('[HILFE] Bitte folgenden Befehl auf dem Server ausführen:');
                    this.addInstallLog('[HILFE]   sudo visudo');
                    this.addInstallLog('[HILFE] Dann diese Zeile hinzufügen:');
                    this.addInstallLog('[HILFE]   iobroker ALL=(ALL) NOPASSWD: ' + process.execPath + ' /opt/iobroker/node_modules/iobroker.js');
                    this.addInstallLog('[HILFE] Danach: iobroker restart mbrepository');
                    throw new Error('sudo: Passwort erforderlich — NOPASSWD in sudoers konfigurieren (Details in der Konsole)');
                }
                throw e2;
            }
        }

        throw new Error('Installation fehlgeschlagen (sudo deaktiviert, direkter Zugriff verweigert)');
    }

    // ─── HTTP Server ─────────────────────────────────────────────────────────

    startHttpServer(port) {
        this.httpServer = http.createServer(async (req, res) => {
            const urlObj   = new URL(req.url, 'http://localhost:' + port);
            const pathname = urlObj.pathname;

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

            // ── Serve UI ──────────────────────────────────────────────────
            if (pathname === '/' || pathname === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(this.buildHtml());
                return;
            }

            // ── API: ping ─────────────────────────────────────────────────
            if (pathname === '/api/ping') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, adapter: 'mbrepository', version: this.pack.version }));
                return;
            }

            // ── API: repos ────────────────────────────────────────────────
            if (pathname === '/api/repos' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, repos: this.repos, lastScan: this.lastScan, scanning: this.scanRunning, scanError: this.lastScanError }));
                return;
            }

            // ── API: scan ─────────────────────────────────────────────────
            if (pathname === '/api/scan' && req.method === 'POST') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, msg: 'Scan gestartet' }));
                this.scanRepositories().catch(e => this.addLog('error', 'SCAN', e.message));
                return;
            }

            // ── API: logs ─────────────────────────────────────────────────
            if (pathname === '/api/logs') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, logs: this.logs }));
                return;
            }

            // ── API: installlog ───────────────────────────────────────────
            if (pathname === '/api/installlog') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, log: this.installLog }));
                return;
            }

            // ── API: install ──────────────────────────────────────────────
            if (pathname === '/api/install' && req.method === 'POST') {
                let body = '';
                req.on('data', c => { body += c; });
                req.on('end', async () => {
                    try {
                        const { repoName } = JSON.parse(body);
                        const ghUser    = this.config.githubUser || 'MPunktBPunkt';
                        const repoLower = repoName.toLowerCase();
                        const repoUrl   = 'https://github.com/' + ghUser + '/' + repoLower;
                        this.addInstallLog('[START] Installiere ' + repoLower + '...');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, msg: 'Installation gestartet' }));
                        try {
                            const adName = repoLower.replace(/^iobroker\./, '');
                            // 1. Lade Adapter-Paket von GitHub
                            this.addInstallLog('[STEP 1/3] iobroker url ' + repoUrl);
                            await this.runCommand('url ' + repoUrl);
                            // 2. Instanz anlegen
                            this.addInstallLog('[STEP 2/3] iobroker add ' + adName);
                            await this.runCommand('add ' + adName);
                            // 3. Starten
                            this.addInstallLog('[STEP 3/3] iobroker start ' + adName);
                            await this.runCommand('start ' + adName);
                            this.addLog('info', 'INSTALL', repoName + ' erfolgreich installiert');
                            this.addInstallLog('[SUCCESS] ' + repoName + ' installiert und gestartet');
                            await this.scanRepositories();
                        } catch (e) {
                            this.addLog('error', 'INSTALL', 'Installation fehlgeschlagen: ' + e.message);
                            this.addInstallLog('[FAIL] ' + e.message);
                        }
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    }
                });
                return;
            }

            // ── API: upgrade/downgrade ─────────────────────────────────────
            if (pathname === '/api/upgrade' && req.method === 'POST') {
                let body = '';
                req.on('data', c => { body += c; });
                req.on('end', async () => {
                    try {
                        const { adapterName, repoName, tag, forceLatest } = JSON.parse(body);
                        const ghUser    = this.config.githubUser || 'MPunktBPunkt';
                        const repoLower = repoName.toLowerCase();
                        let repoUrl     = 'https://github.com/' + ghUser + '/' + repoLower;
                        // forceLatest: kein Tag anhängen → main-Branch
                        if (!forceLatest && tag) repoUrl += '#' + tag;

                        const label = forceLatest ? 'main (latest)' : (tag ? tag : 'latest');
                        this.addInstallLog('[START] Upgrade ' + adapterName + ' -> ' + label + '...');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, msg: 'Upgrade gestartet' }));

                        try {
                            // 1. Lade neue Version von GitHub
                            this.addInstallLog('[STEP 1/2] iobroker url ' + repoUrl);
                            await this.runCommand('url ' + repoUrl);
                            // 2. Adapter neu starten (ioBroker lädt die neue Version beim Start)
                            this.addInstallLog('[STEP 2/2] iobroker restart ' + adapterName);
                            await this.runCommand('restart ' + adapterName);
                            this.addLog('info', 'UPGRADE', adapterName + ' erfolgreich aktualisiert');
                            this.addInstallLog('[SUCCESS] ' + adapterName + ' aktualisiert und neu gestartet');
                            await this.scanRepositories();
                        } catch (e) {
                            this.addLog('error', 'UPGRADE', 'Upgrade fehlgeschlagen: ' + e.message);
                            this.addInstallLog('[FAIL] ' + e.message);
                        }
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    }
                });
                return;
            }

            // ── API: version check ────────────────────────────────────────
            if (pathname === '/api/version') {
                try {
                    const ghUser = this.config.githubUser || 'MPunktBPunkt';
                    const rel = await this.fetchJson(
                        'https://api.github.com/repos/' + ghUser + '/iobroker.mbrepository/releases/latest'
                    );
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, installed: this.pack.version, latest: rel.tag_name || 'unbekannt' }));
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, installed: this.pack.version, error: e.message }));
                }
                return;
            }

            // ── API: selfupdate ───────────────────────────────────────────
            if (pathname === '/api/selfupdate' && req.method === 'POST') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, msg: 'Self-Update gestartet' }));
                const ghUser = this.config.githubUser || 'MPunktBPunkt';
                this.addInstallLog('[START] Self-Update MBRepository...');
                const selfUrl = 'https://github.com/' + ghUser + '/iobroker.mbrepository';
                this.addInstallLog('[STEP 1/2] iobroker url ' + selfUrl);
                this.runCommand('url ' + selfUrl)
                .then(() => {
                    this.addInstallLog('[STEP 2/2] iobroker restart mbrepository');
                    return this.runCommand('restart mbrepository');
                }).then(() => {
                    this.addInstallLog('[SUCCESS] Self-Update abgeschlossen, Neustart...');
                    setTimeout(() => process.exit(0), 2000);
                }).catch(e => {
                    this.addInstallLog('[FAIL] ' + e.message);
                });
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        });

        this.httpServer.listen(port, () => {
            this.addLog('info', 'SYSTEM', 'Web-UI erreichbar unter http://IP:' + port + '/');
        });
        this.httpServer.on('error', err => {
            this.addLog('error', 'SYSTEM', 'HTTP Server Fehler: ' + err.message);
        });
    }

    // ─── HTML Builder ─────────────────────────────────────────────────────────

    buildHtml() {
        const v = this.pack ? this.pack.version : '0.0.0';

        // Build inline HTML with all CSS + JS
        // Using string concatenation to avoid template literal issues
        const parts = [];

        parts.push('<!DOCTYPE html>');
        parts.push('<html lang="de">');
        parts.push('<head>');
        parts.push('<meta charset="UTF-8">');
        parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
        parts.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
        parts.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
        parts.push('<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">');
        parts.push('<title>ioBroker MBRepository v' + v + '</title>');
        parts.push('<style>');
        parts.push(this.getCSS());
        parts.push('</style>');
        parts.push('</head>');
        parts.push('<body>');
        parts.push(this.getBodyHTML(v));
        parts.push('<script>');
        parts.push(this.getJS());
        parts.push('</script>');
        parts.push('</body>');
        parts.push('</html>');

        return parts.join('\n');
    }

    getCSS() {
        return [
'*{margin:0;padding:0;box-sizing:border-box}',
':root{',
'  --bg-primary:#06080d;',
'  --bg-secondary:#0a0e14;',
'  --bg-card:rgba(12,16,24,0.92);',
'  --bg-hover:#141a24;',
'  --bg-elevated:#1a2230;',
'  --border:#1e2a3a;',
'  --border-bright:#2d3f56;',
'  --cyan:#00e5c0;',
'  --cyan-dim:#00a88a;',
'  --blue:#58a6ff;',
'  --blue-dim:#1f6feb;',
'  --green:#3fb950;',
'  --green-neon:#39ff14;',
'  --yellow:#e3b341;',
'  --red:#f85149;',
'  --orange:#ff9f43;',
'  --purple:#bc8cff;',
'  --text:#e6edf3;',
'  --text-muted:#7d8590;',
'  --text-dim:#484f58;',
'  --mono:"JetBrains Mono","Cascadia Code","Fira Code",monospace;',
'  --sans:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;',
'  --radius:10px;',
'  --glow-cyan:0 0 24px rgba(0,229,192,0.12);',
'  --glow-green:0 0 20px rgba(63,185,80,0.15);',
'  --glow-orange:0 0 20px rgba(255,159,67,0.12);',
'}',
'html{scroll-behavior:smooth}',
'body{',
'  background:var(--bg-primary);',
'  background-image:',
'    radial-gradient(ellipse 80% 50% at 50% -20%,rgba(0,229,192,0.07),transparent),',
'    linear-gradient(rgba(30,42,58,0.35) 1px,transparent 1px),',
'    linear-gradient(90deg,rgba(30,42,58,0.35) 1px,transparent 1px);',
'  background-size:100% 100%,28px 28px,28px 28px;',
'  color:var(--text);',
'  font-family:var(--sans);',
'  font-size:14px;',
'  min-height:100vh;',
'  line-height:1.5;',
'}',
'.mono{font-family:var(--mono)}',

'header{',
'  background:rgba(10,14,20,0.95);',
'  backdrop-filter:blur(12px);',
'  border-bottom:1px solid var(--border);',
'  padding:14px 24px;',
'  display:flex;',
'  align-items:center;',
'  gap:14px;',
'  position:sticky;top:0;z-index:100;',
'}',
'.logo{',
'  width:38px;height:38px;',
'  background:linear-gradient(135deg,#0d2137 0%,#1a3a5c 100%);',
'  border:1px solid var(--cyan-dim);',
'  border-radius:8px;',
'  display:flex;align-items:center;justify-content:center;',
'  font-size:18px;',
'  box-shadow:var(--glow-cyan);',
'  position:relative;overflow:hidden;',
'}',
'.logo::after{',
'  content:"";position:absolute;inset:0;',
'  background:linear-gradient(135deg,transparent 40%,rgba(0,229,192,0.15) 100%);',
'}',
'.header-main{flex:1;min-width:0}',
'.header-title{',
'  font-family:var(--mono);',
'  font-size:15px;font-weight:600;',
'  color:var(--text);',
'  letter-spacing:-0.02em;',
'}',
'.header-title .prompt{color:var(--cyan);margin-right:4px}',
'.header-title .path{color:var(--text-muted);font-weight:400}',
'.header-prompt{',
'  font-family:var(--mono);',
'  font-size:11px;color:var(--text-dim);',
'  margin-top:2px;',
'}',
'.header-prompt .cursor{',
'  display:inline-block;width:7px;height:13px;',
'  background:var(--cyan);margin-left:2px;',
'  animation:blink 1.2s step-end infinite;vertical-align:text-bottom;',
'}',
'@keyframes blink{50%{opacity:0}}',
'.header-badges{display:flex;align-items:center;gap:8px;flex-shrink:0}',
'.header-badge{',
'  font-family:var(--mono);',
'  background:rgba(31,111,235,0.15);',
'  color:var(--blue);',
'  font-size:10px;padding:3px 10px;',
'  border-radius:4px;font-weight:600;',
'  border:1px solid rgba(88,166,255,0.25);',
'  letter-spacing:0.04em;',
'}',
'.header-sub{',
'  font-family:var(--mono);',
'  font-size:11px;color:var(--text-muted);',
'  text-align:right;white-space:nowrap;',
'}',

'.tabs{',
'  background:rgba(10,14,20,0.9);',
'  backdrop-filter:blur(8px);',
'  border-bottom:1px solid var(--border);',
'  display:flex;gap:0;padding:0 24px;overflow-x:auto;',
'}',
'.tab{',
'  font-family:var(--mono);',
'  padding:11px 16px;cursor:pointer;',
'  border-bottom:2px solid transparent;',
'  color:var(--text-muted);',
'  font-size:12px;font-weight:500;',
'  transition:all .2s;',
'  background:none;border-left:none;border-right:none;border-top:none;',
'  outline:none;white-space:nowrap;',
'  letter-spacing:0.02em;',
'}',
'.tab:hover{color:var(--cyan);background:rgba(0,229,192,0.04)}',
'.tab.active{color:var(--cyan);border-bottom-color:var(--cyan);background:rgba(0,229,192,0.06)}',
'.tab .tab-icon{opacity:0.7;margin-right:6px;font-style:normal}',
'.tab.active .tab-icon{opacity:1}',

'.content{padding:20px 24px;max-width:1400px;margin:0 auto}',
'.tab-panel{display:none}.tab-panel.active{display:block}',

'.stats-bar{',
'  display:none;grid-template-columns:repeat(4,1fr);gap:10px;',
'  margin-bottom:18px;',
'}',
'.stats-bar.visible{display:grid}',
'@media(max-width:700px){.stats-bar{grid-template-columns:repeat(2,1fr)}}',
'.stat-chip{',
'  background:var(--bg-card);',
'  border:1px solid var(--border);',
'  border-radius:var(--radius);',
'  padding:12px 14px;',
'  display:flex;align-items:center;gap:10px;',
'  transition:border-color .2s,box-shadow .2s;',
'}',
'.stat-chip:hover{border-color:var(--border-bright)}',
'.stat-chip.stat-updates{border-color:rgba(255,159,67,0.35);box-shadow:var(--glow-orange)}',
'.stat-chip.stat-missing{border-color:rgba(188,140,255,0.3)}',
'.stat-icon{font-size:18px;line-height:1;opacity:0.85}',
'.stat-body{min-width:0}',
'.stat-val{',
'  font-family:var(--mono);',
'  font-size:20px;font-weight:700;line-height:1.1;',
'  color:var(--text);',
'}',
'.stat-label{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-top:2px}',

'.toolbar{',
'  display:flex;align-items:center;gap:10px;',
'  margin-bottom:16px;flex-wrap:wrap;',
'  background:var(--bg-card);',
'  border:1px solid var(--border);',
'  border-radius:var(--radius);',
'  padding:12px 14px;',
'}',
'.btn{',
'  font-family:var(--mono);',
'  padding:8px 14px;border:none;border-radius:6px;',
'  cursor:pointer;font-size:12px;font-weight:500;',
'  transition:all .2s;',
'  display:inline-flex;align-items:center;gap:6px;',
'  letter-spacing:0.02em;',
'}',
'.btn-primary{',
'  background:linear-gradient(180deg,rgba(0,168,138,0.25) 0%,rgba(0,168,138,0.12) 100%);',
'  color:var(--cyan);border:1px solid rgba(0,229,192,0.35);',
'}',
'.btn-primary:hover{background:rgba(0,229,192,0.2);box-shadow:var(--glow-cyan);color:#fff}',
'.btn-success{',
'  background:rgba(63,185,80,0.12);color:var(--green);',
'  border:1px solid rgba(63,185,80,0.35);',
'}',
'.btn-success:hover{background:rgba(63,185,80,0.22);box-shadow:var(--glow-green)}',
'.btn-warning{background:rgba(255,159,67,0.12);color:var(--orange);border:1px solid rgba(255,159,67,0.35)}',
'.btn-warning:hover{background:rgba(255,159,67,0.22)}',
'.btn-danger{background:rgba(248,81,73,0.12);color:var(--red);border:1px solid rgba(248,81,73,0.35)}',
'.btn-danger:hover{background:rgba(248,81,73,0.22)}',
'.btn-muted{background:var(--bg-hover);color:var(--text-muted);border:1px solid var(--border)}',
'.btn-muted:hover{color:var(--text);border-color:var(--border-bright)}',
'.btn:disabled{opacity:0.4;cursor:not-allowed}',
'.btn.spin svg{animation:spin 1s linear infinite}',
'@keyframes spin{to{transform:rotate(360deg)}}',

'.toggle-group{',
'  display:flex;align-items:center;gap:2px;',
'  background:var(--bg-hover);',
'  border:1px solid var(--border);',
'  border-radius:6px;padding:3px;',
'}',
'.toggle-opt{',
'  font-family:var(--mono);',
'  padding:6px 12px;border-radius:4px;cursor:pointer;',
'  font-size:11px;font-weight:500;color:var(--text-muted);',
'  transition:all .2s;border:none;background:none;',
'}',
'.toggle-opt.active{background:rgba(0,229,192,0.18);color:var(--cyan);font-weight:600}',
'.toggle-opt:hover:not(.active){color:var(--text)}',

'.scan-status{',
'  font-family:var(--mono);',
'  font-size:11px;color:var(--text-muted);margin-left:auto;',
'  display:flex;align-items:center;gap:6px;',
'}',
'.scan-status .dot{width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0}',
'.scan-status .dot.scanning{background:var(--orange);animation:pulse .8s ease-in-out infinite;box-shadow:0 0 8px var(--orange)}',
'@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(0.85)}}',

'.repo-list{display:flex;flex-direction:column;gap:10px}',
'.repo-card{',
'  background:var(--bg-card);',
'  border:1px solid var(--border);',
'  border-radius:var(--radius);',
'  padding:0;',
'  transition:border-color .25s,box-shadow .25s,transform .2s;',
'  overflow:hidden;',
'  position:relative;',
'}',
'.repo-card::before{',
'  content:"";position:absolute;left:0;top:0;bottom:0;width:3px;',
'  background:var(--card-accent,var(--text-dim));',
'}',
'.repo-card:hover{border-color:var(--border-bright);transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,0,0,0.35)}',
'.repo-card.status-current{--card-accent:var(--green)}',
'.repo-card.status-current:hover{box-shadow:var(--glow-green)}',
'.repo-card.status-update{--card-accent:var(--orange)}',
'.repo-card.status-update:hover{box-shadow:var(--glow-orange)}',
'.repo-card.status-missing{--card-accent:var(--purple)}',
'.repo-card.status-newer{--card-accent:var(--blue)}',
'.repo-card-inner{padding:14px 16px 14px 18px}',
'.repo-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:10px}',
'.repo-icon{',
'  width:40px;height:40px;',
'  background:linear-gradient(145deg,rgba(31,111,235,0.2),rgba(0,229,192,0.08));',
'  border:1px solid var(--border-bright);',
'  border-radius:8px;',
'  display:flex;align-items:center;justify-content:center;',
'  font-size:14px;flex-shrink:0;',
'  font-family:var(--mono);color:var(--cyan);font-weight:600;',
'}',
'.repo-name{',
'  font-family:var(--mono);',
'  font-size:14px;font-weight:600;color:var(--cyan);',
'}',
'.repo-name a{color:inherit;text-decoration:none}',
'.repo-name a:hover{text-decoration:underline;text-underline-offset:3px}',
'.repo-desc{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.45}',
'.repo-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}',

'.badge{',
'  font-family:var(--mono);',
'  font-size:10px;padding:3px 8px;border-radius:4px;',
'  font-weight:600;white-space:nowrap;letter-spacing:0.03em;',
'}',
'.badge-installed{background:rgba(63,185,80,0.12);color:#7ee787;border:1px solid rgba(63,185,80,0.35)}',
'.badge-not-installed{background:rgba(125,133,144,0.1);color:#aaaaaa;border:1px solid rgba(125,133,144,0.25)}',
'.badge-update{background:rgba(255,159,67,0.12);color:#ffb366;border:1px solid rgba(255,159,67,0.4)}',
'.badge-newer{background:rgba(88,166,255,0.1);color:#79c0ff;border:1px solid rgba(88,166,255,0.35)}',
'.badge-latest{background:rgba(63,185,80,0.12);color:#7ee787;border:1px solid rgba(63,185,80,0.4)}',
'.badge-release{background:rgba(31,111,235,0.12);color:#79c0ff;border:1px solid rgba(88,166,255,0.3)}',
'.badge-tag{background:rgba(188,140,255,0.1);color:#d2a8ff;border:1px solid rgba(188,140,255,0.35)}',
'.meta-chip{',
'  font-family:var(--mono);',
'  font-size:10px;color:var(--text-dim);',
'  display:inline-flex;align-items:center;gap:4px;',
'}',

'.version-row{',
'  display:flex;align-items:center;gap:8px;flex-wrap:wrap;',
'  margin:10px 0 0;',
'  padding:8px 12px;',
'  background:rgba(0,0,0,0.25);',
'  border:1px solid var(--border);',
'  border-radius:6px;',
'  font-family:var(--mono);font-size:11px;',
'}',
'.version-label{color:var(--text-dim)}',
'.version-value{font-weight:600}',
'.version-value.inst{color:var(--green)}',
'.version-value.upstream{color:var(--blue)}',
'.version-arrow{color:var(--text-dim);font-size:12px;opacity:0.6}',

'.repo-actions{',
'  display:flex;gap:8px;flex-wrap:wrap;',
'  margin-top:12px;padding-top:12px;',
'  border-top:1px solid var(--border);',
'}',
'.select-version,select,.nodes-select{',
'  font-family:var(--mono);',
'  background:var(--bg-hover);',
'  border:1px solid var(--border);',
'  color:var(--text);',
'  border-radius:6px;padding:6px 10px;font-size:11px;outline:none;',
'}',
'.select-version:focus,.nodes-select:focus{border-color:var(--cyan-dim);box-shadow:0 0 0 2px rgba(0,229,192,0.1)}',
'.nodes-select{width:300px;max-width:100%}',

'.panel-title{',
'  font-family:var(--mono);',
'  font-size:11px;color:var(--text-dim);',
'  text-transform:uppercase;letter-spacing:0.1em;',
'  margin-bottom:10px;display:flex;align-items:center;gap:8px;',
'}',
'.panel-title::before{content:"//";color:var(--cyan);opacity:0.6}',

'.log-container{',
'  background:#040608;',
'  border:1px solid var(--border);',
'  border-radius:var(--radius);',
'  height:520px;overflow-y:auto;',
'  font-family:var(--mono);font-size:11px;',
'  box-shadow:inset 0 2px 20px rgba(0,0,0,0.5);',
'}',
'.log-container::before{',
'  content:"tail -f mbrepository.log";',
'  display:block;padding:8px 14px;',
'  font-size:10px;color:var(--text-dim);',
'  border-bottom:1px solid var(--border);',
'  background:rgba(0,229,192,0.03);',
'  letter-spacing:0.04em;',
'}',
'.log-entry{padding:3px 14px;border-bottom:1px solid rgba(30,42,58,0.5);display:flex;gap:10px;align-items:flex-start}',
'.log-entry:hover{background:rgba(0,229,192,0.03)}',
'.log-entry:nth-child(even){background:rgba(255,255,255,0.01)}',
'.log-ts{color:var(--text-dim);white-space:nowrap;min-width:72px;font-size:10px;padding-top:2px}',
'.log-level{font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;min-width:44px;text-align:center;letter-spacing:0.05em}',
'.log-cat{color:var(--purple);min-width:64px;font-size:10px}',
'.log-msg{color:var(--text);word-break:break-word;flex:1}',
'.lvl-info{background:rgba(88,166,255,0.15);color:var(--blue)}',
'.lvl-warn{background:rgba(255,159,67,0.15);color:var(--orange)}',
'.lvl-error{background:rgba(248,81,73,0.15);color:var(--red)}',
'.lvl-debug{background:rgba(125,133,144,0.12);color:var(--text-muted)}',
'.lvl-system{background:rgba(63,185,80,0.12);color:var(--green)}',

'.debug-container{',
'  background:#030508;',
'  border:1px solid var(--border);',
'  border-radius:var(--radius);',
'  height:420px;overflow-y:auto;',
'  font-family:var(--mono);font-size:11px;',
'  padding:0;',
'  box-shadow:inset 0 2px 20px rgba(0,0,0,0.5);',
'}',
'.debug-header{',
'  padding:8px 14px;font-size:10px;color:var(--text-dim);',
'  border-bottom:1px solid var(--border);',
'  background:rgba(0,229,192,0.03);',
'  display:flex;align-items:center;gap:8px;letter-spacing:0.04em;',
'}',
'.debug-header .dot-r,.debug-header .dot-y,.debug-header .dot-g{',
'  width:10px;height:10px;border-radius:50%;display:inline-block;',
'}',
'.debug-header .dot-r{background:#ff5f57}',
'.debug-header .dot-y{background:#febc2e}',
'.debug-header .dot-g{background:#28c840}',
'.debug-body{padding:8px 14px}',
'.debug-line{padding:2px 0;border-bottom:1px solid rgba(20,26,36,0.8);line-height:1.55}',
'.debug-line.cmd{color:#58a6ff}',
'.debug-line.cmd::before{content:"$ ";color:var(--cyan);opacity:0.7}',
'.debug-line.success{color:var(--green)}',
'.debug-line.fail{color:var(--red)}',
'.debug-line.stderr{color:var(--yellow)}',
'.debug-line.exit{color:var(--text-muted);font-style:italic}',
'.debug-line.start{color:var(--orange)}',

'.nodes-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
'@media(max-width:900px){.nodes-grid{grid-template-columns:1fr}}',
'.nodes-card{',
'  background:var(--bg-card);',
'  border:1px solid var(--border);',
'  border-radius:var(--radius);padding:14px 16px;',
'}',
'.nodes-card h3{',
'  font-family:var(--mono);',
'  font-size:11px;font-weight:600;color:var(--text-muted);',
'  margin-bottom:12px;display:flex;align-items:center;gap:8px;',
'  text-transform:uppercase;letter-spacing:0.06em;',
'}',
'.nodes-card h3 .count{',
'  margin-left:auto;background:var(--bg-hover);',
'  padding:2px 8px;border-radius:4px;color:var(--cyan);font-size:10px;',
'}',
'.nodes-item{',
'  padding:8px 10px;border-radius:6px;',
'  display:flex;align-items:center;gap:8px;margin-bottom:4px;',
'  background:var(--bg-hover);cursor:default;',
'  transition:background .15s,border-color .15s;',
'  border:1px solid transparent;font-family:var(--mono);font-size:11px;',
'}',
'.nodes-item:hover{background:var(--bg-elevated);border-color:var(--border-bright)}',
'.nodes-item-name{flex:1;font-weight:500;color:var(--text)}',
'.nodes-item-meta{font-size:10px;color:var(--text-dim)}',
'.nodes-item-meta.sha{color:var(--purple);font-family:var(--mono)}',

'.system-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
'@media(max-width:900px){.system-grid{grid-template-columns:1fr}}',
'.system-card{',
'  background:var(--bg-card);',
'  border:1px solid var(--border);',
'  border-radius:var(--radius);padding:16px;',
'}',
'.system-card h3{',
'  font-family:var(--mono);',
'  font-size:11px;font-weight:600;color:var(--text-muted);',
'  margin-bottom:12px;text-transform:uppercase;letter-spacing:0.06em;',
'}',
'.info-row{',
'  display:flex;justify-content:space-between;align-items:center;',
'  padding:7px 0;border-bottom:1px solid var(--border);',
'  font-size:12px;gap:12px;',
'}',
'.info-row:last-child{border-bottom:none}',
'.info-key{color:var(--text-muted);font-size:11px}',
'.info-val{color:var(--text);font-weight:500;font-family:var(--mono);font-size:11px}',

'.console-section{margin-top:18px}',
'.console-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}',
'.console-toolbar h3{',
'  font-family:var(--mono);',
'  font-size:12px;font-weight:600;color:var(--text);',
'  margin-right:auto;',
'}',

'select option{background:var(--bg-card);color:var(--text)}',
'::-webkit-scrollbar{width:5px;height:5px}',
'::-webkit-scrollbar-track{background:var(--bg-secondary)}',
'::-webkit-scrollbar-thumb{background:#2d3f56;border-radius:3px}',
'::-webkit-scrollbar-thumb:hover{background:#3d5168}',
'.empty-state{',
'  text-align:center;padding:56px 20px;color:var(--text-muted);',
'  background:var(--bg-card);',
'  border:1px dashed var(--border);',
'  border-radius:var(--radius);',
'}',
'.empty-state .icon{font-size:40px;margin-bottom:14px;opacity:0.7}',
'.empty-state p{font-size:13px;font-family:var(--mono);font-size:12px}',
'.empty-state .hint{font-size:11px;color:var(--text-dim);margin-top:8px}',
'.toolbar-label{font-size:11px;color:var(--text-dim);font-family:var(--mono)}',
'input[type=checkbox]{accent-color:var(--cyan)}',
'label.toolbar-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted);cursor:pointer;font-family:var(--mono)}',
'.log-filter{background:var(--bg-hover)!important;border:1px solid var(--border)!important;color:var(--text)!important;border-radius:6px!important;padding:6px 10px!important;font-size:11px!important;font-family:var(--mono)!important}'
        ].join('\n');
    }

    getBodyHTML(v) {
        return [
'<header>',
'  <div class="logo">&lt;/&gt;</div>',
'  <div class="header-main">',
'    <div class="header-title"><span class="prompt">$</span> mbrepository<span class="path">/manager</span></div>',
'    <div class="header-prompt">git fetch origin --all<span class="cursor"></span></div>',
'  </div>',
'  <div class="header-badges">',
'    <span class="header-badge">v' + v + '</span>',
'  </div>',
'  <div class="header-sub" id="headerSub">ready</div>',
'</header>',

'<div class="tabs">',
'  <button class="tab active" id="tab-data"    onclick="showTab(\'data\')"><span class="tab-icon">&#9670;</span>repos</button>',
'  <button class="tab"        id="tab-nodes"   onclick="showTab(\'nodes\')"><span class="tab-icon">&#9670;</span>tags</button>',
'  <button class="tab"        id="tab-logs"    onclick="showTab(\'logs\')"><span class="tab-icon">&#9670;</span>logs</button>',
'  <button class="tab"        id="tab-system"  onclick="showTab(\'system\')"><span class="tab-icon">&#9670;</span>system</button>',
'</div>',

'<div class="content">',

// ── TAB: DATEN ──────────────────────────────────────────────────────────────
'<div class="tab-panel active" id="panel-data">',
'  <div class="stats-bar" id="statsBar">',
'    <div class="stat-chip"><span class="stat-icon">&#128230;</span><div class="stat-body"><div class="stat-val" id="statTotal">0</div><div class="stat-label">Repositories</div></div></div>',
'    <div class="stat-chip"><span class="stat-icon">&#10003;</span><div class="stat-body"><div class="stat-val" id="statInstalled">0</div><div class="stat-label">Installiert</div></div></div>',
'    <div class="stat-chip stat-updates"><span class="stat-icon">&#8679;</span><div class="stat-body"><div class="stat-val" id="statUpdates">0</div><div class="stat-label">Updates</div></div></div>',
'    <div class="stat-chip stat-missing"><span class="stat-icon">&#9675;</span><div class="stat-body"><div class="stat-val" id="statMissing">0</div><div class="stat-label">Fehlend</div></div></div>',
'  </div>',
'  <div class="toolbar">',
'    <button class="btn btn-primary" id="btnScan" onclick="doScan()">',
'      <svg id="scanIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
'      git fetch',
'    </button>',
'    <div class="toggle-group">',
'      <button class="toggle-opt active" id="tog-releases" onclick="setToggle(\'releases\')">releases</button>',
'      <button class="toggle-opt"        id="tog-latest"   onclick="setToggle(\'latest\')">main</button>',
'    </div>',
'    <div class="scan-status"><span class="dot" id="scanDot"></span><span id="scanStatusText">kein scan</span></div>',
'  </div>',
'  <div id="repoList" class="repo-list">',
'    <div class="empty-state"><div class="icon">&#128269;</div><p>$ mbrepository scan --github</p><p class="hint">Klicke auf &quot;git fetch&quot; um Repositories zu laden.</p></div>',
'  </div>',
'</div>',

// ── TAB: NODES ──────────────────────────────────────────────────────────────
'<div class="tab-panel" id="panel-nodes">',
'  <div class="panel-title">git tag &amp; release history</div>',
'  <div class="toolbar">',
'    <select class="nodes-select" id="nodesRepoSelect" onchange="loadNodes()">',
'      <option value="">-- repository w\u00e4hlen --</option>',
'    </select>',
'    <button class="btn btn-muted" onclick="loadNodes()">&#8635; reload</button>',
'  </div>',
'  <div class="nodes-grid" id="nodesGrid">',
'    <div class="empty-state" style="grid-column:1/-1"><div class="icon">&#128337;</div><p>$ git tag -l</p><p class="hint">Repository w\u00e4hlen um Releases und Tags anzuzeigen.</p></div>',
'  </div>',
'</div>',

// ── TAB: LOGS ───────────────────────────────────────────────────────────────
'<div class="tab-panel" id="panel-logs">',
'  <div class="toolbar">',
'    <button class="btn btn-muted" onclick="loadLogs()">&#8635; refresh</button>',
'    <button class="btn btn-muted" onclick="clearLogs()">&#128465; clear</button>',
'    <select id="logLevelFilter" class="log-filter" onchange="loadLogs()">',
'      <option value="">all levels</option>',
'      <option value="info">info</option>',
'      <option value="warn">warn</option>',
'      <option value="error">error</option>',
'      <option value="debug">debug</option>',
'    </select>',
'    <label class="toolbar-check">',
'      <input type="checkbox" id="autoScrollLog" checked> auto-scroll',
'    </label>',
'    <button class="btn btn-muted" onclick="exportLogs()">&#8659; export</button>',
'  </div>',
'  <div class="log-container" id="logContainer"></div>',
'</div>',

// ── TAB: SYSTEM ─────────────────────────────────────────────────────────────
'<div class="tab-panel" id="panel-system">',
'  <div class="system-grid">',

'  <div class="system-card">',
'    <h3>&#9670; adapter info</h3>',
'    <div id="adapterInfo">',
'      <div class="info-row"><span class="info-key">version (local)</span><span class="info-val" id="sysVerInst">v' + v + '</span></div>',
'      <div class="info-row"><span class="info-key">version (remote)</span><span class="info-val" id="sysVerLatest">-</span></div>',
'      <div class="info-row"><span class="info-key">last scan</span><span class="info-val" id="sysLastScan">-</span></div>',
'      <div class="info-row"><span class="info-key">repos found</span><span class="info-val" id="sysRepoCount">-</span></div>',
'    </div>',
'    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">',
'      <button class="btn btn-primary" onclick="checkSelfVersion()">check updates</button>',
'      <button class="btn btn-success" id="btnSelfUpdate" style="display:none" onclick="doSelfUpdate()">git pull --self</button>',
'    </div>',
'  </div>',

'  <div class="system-card">',
'    <h3>&#9670; install adapter</h3>',
'    <p style="font-size:11px;color:var(--text-muted);margin-bottom:12px;font-family:var(--mono)">iobroker add &lt;repo&gt; via sudo</p>',
'    <select id="installSelect" class="select-version" style="width:100%;margin-bottom:10px">',
'      <option value="">-- adapter w\u00e4hlen (nicht installiert) --</option>',
'    </select>',
'    <button class="btn btn-success" onclick="doInstall()" style="width:100%">',
'      &#9654; iobroker add',
'    </button>',
'  </div>',

'  </div>',

'  <div class="console-section">',
'    <div class="console-toolbar">',
'      <h3>install console</h3>',
'      <button class="btn btn-muted" onclick="loadInstallLog()">&#8635;</button>',
'      <button class="btn btn-muted" onclick="clearInstallLog()">clear</button>',
'      <label class="toolbar-check">',
'        <input type="checkbox" id="autoScrollDebug" checked> auto-scroll',
'      </label>',
'    </div>',
'    <div class="debug-container" id="debugContainer">',
'      <div class="debug-header"><span class="dot-r"></span><span class="dot-y"></span><span class="dot-g"></span> bash — iobroker install</div>',
'      <div class="debug-body" id="debugBody"></div>',
'    </div>',
'  </div>',
'</div>',

'</div>' // .content
        ].join('\n');
    }

    getJS() {
        return [
'// ── State ──────────────────────────────────────────────────────────────',
'var repos = [];',
'var viewMode = "releases";',
'var logData  = [];',
'var logPollTimer = null;',
'var debugPollTimer = null;',
'',
'// ── Tabs ────────────────────────────────────────────────────────────────',
'window.showTab = function(name) {',
'  document.querySelectorAll(".tab-panel").forEach(function(p){ p.classList.remove("active"); });',
'  document.querySelectorAll(".tab").forEach(function(t){ t.classList.remove("active"); });',
'  var panel = document.getElementById("panel-" + name);',
'  var tab   = document.getElementById("tab-"   + name);',
'  if (panel) panel.classList.add("active");',
'  if (tab)   tab.classList.add("active");',
'  if (name === "logs")   { loadLogs(); startLogPoll(); }',
'  else                   { stopLogPoll(); }',
'  if (name === "system") { checkSelfVersion(); loadInstallLog(); startDebugPoll(); }',
'  else                   { stopDebugPoll(); }',
'  if (name === "nodes")  { populateNodesSelect(); }',
'};',
'',
'function startLogPoll()  { if (!logPollTimer)   logPollTimer   = setInterval(loadLogs,       5000); }',
'function stopLogPoll()   { clearInterval(logPollTimer);   logPollTimer   = null; }',
'function startDebugPoll(){ if (!debugPollTimer) debugPollTimer = setInterval(loadInstallLog, 2000); }',
'function stopDebugPoll() { clearInterval(debugPollTimer); debugPollTimer = null; }',
'',
'// ── Toggle ──────────────────────────────────────────────────────────────',
'window.setToggle = function(mode) {',
'  viewMode = mode;',
'  document.getElementById("tog-releases").classList.toggle("active", mode === "releases");',
'  document.getElementById("tog-latest").classList.toggle("active",   mode === "latest");',
'  renderRepoList();',
'};',
'',
'// ── Scan ────────────────────────────────────────────────────────────────',
'window.doScan = function() {',
'  var btn  = document.getElementById("btnScan");',
'  var icon = document.getElementById("scanIcon");',
'  var dot  = document.getElementById("scanDot");',
'  btn.disabled = true;',
'  icon.parentElement.classList.add("spin");',
'  dot.classList.add("scanning");',
'  document.getElementById("scanStatusText").textContent = "scanne...";',
'  document.getElementById("headerSub").textContent = "fetching...";',
'',
'  fetch("/api/scan", { method: "POST" })',
'    .then(function() {',
'      pollForScanComplete();',
'    })',
'    .catch(function(e) {',
'      btn.disabled = false;',
'      icon.parentElement.classList.remove("spin");',
'      dot.classList.remove("scanning");',
'      document.getElementById("scanStatusText").textContent = "Fehler: " + e.message;',
'    });',
'};',
'',
'function pollForScanComplete() {',
'  var timer = setInterval(function() {',
'    fetch("/api/repos")',
'      .then(function(r){ return r.json(); })',
'      .then(function(d) {',
'        if (!d.scanning) {',
'          clearInterval(timer);',
'          repos = d.repos || [];',
'          renderRepoList();',
'          populateNodesSelect();',
'          populateInstallSelect();',
'          var dot = document.getElementById("scanDot");',
'          dot.classList.remove("scanning");',
'          document.getElementById("scanStatusText").textContent =',
'            "last scan: " + (d.lastScan ? new Date(d.lastScan).toLocaleTimeString("de") : "-");',
'          document.getElementById("btnScan").disabled = false;',
'          document.getElementById("scanIcon").parentElement.classList.remove("spin");',
'          document.getElementById("headerSub").textContent = repos.length + " repos";',
'          document.getElementById("sysLastScan").textContent = d.lastScan ? new Date(d.lastScan).toLocaleString("de") : "-";',
'          document.getElementById("sysRepoCount").textContent = repos.length;',
'        }',
'      });',
'  }, 1500);',
'}',
'',
'// ── SemVer Vergleich ────────────────────────────────────────────────────',
'function semverCmp(a, b) {',
'  var pa = a.split(".").map(function(x){ return parseInt(x,10)||0; });',
'  var pb = b.split(".").map(function(x){ return parseInt(x,10)||0; });',
'  var len = Math.max(pa.length, pb.length);',
'  for (var i=0; i<len; i++) {',
'    var diff = (pa[i]||0) - (pb[i]||0);',
'    if (diff !== 0) return diff;',
'  }',
'  return 0;',
'}',
'',
'function updateStats() {',
'  var total = repos.length;',
'  var installed = 0, updates = 0, missing = 0;',
'  repos.forEach(function(r) {',
'    if (r.installed) {',
'      installed++;',
'      if (viewMode !== "latest" && r.latestRelease) {',
'        var cmp = semverCmp(r.installed.replace(/^v/, ""), r.latestRelease.tag.replace(/^v/, ""));',
'        if (cmp < 0) updates++;',
'      }',
'    } else {',
'      missing++;',
'    }',
'  });',
'  var bar = document.getElementById("statsBar");',
'  if (bar) bar.classList.toggle("visible", total > 0);',
'  var el;',
'  el = document.getElementById("statTotal");     if (el) el.textContent = total;',
'  el = document.getElementById("statInstalled"); if (el) el.textContent = installed;',
'  el = document.getElementById("statUpdates");    if (el) el.textContent = updates;',
'  el = document.getElementById("statMissing");   if (el) el.textContent = missing;',
'}',
'',
'function repoStatusClass(r) {',
'  if (!r.installed) return "status-missing";',
'  if (viewMode === "latest") return "status-current";',
'  if (!r.latestRelease) return "status-current";',
'  var cmp = semverCmp(r.installed.replace(/^v/, ""), r.latestRelease.tag.replace(/^v/, ""));',
'  if (cmp === 0) return "status-current";',
'  if (cmp > 0) return "status-newer";',
'  return "status-update";',
'}',
'',
'function repoInitial(name) {',
'  var n = name.replace(/^iobroker\\./i, "");',
'  return n.charAt(0).toUpperCase() || "?";',
'}',
'',
'// ── Render Repo List ───────────────────────────────────────────────────',
'function renderRepoList() {',
'  updateStats();',
'  var el = document.getElementById("repoList");',
'  if (!repos.length) {',
'    el.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icon\\">&#128269;</div><p>$ mbrepository scan --github</p><p class=\\"hint\\">Keine Repositories gefunden.</p></div>";',
'    return;',
'  }',
'  var html = repos.map(function(r) {',
'    var statusCls = repoStatusClass(r);',
'    var instBadge = r.installed',
'      ? "<span class=\\"badge badge-installed\\">&#10003; v" + r.installed + "</span>"',
'      : "<span class=\\"badge badge-not-installed\\">not installed</span>";',
'',
'    var isLatest    = viewMode === "latest";',
'    var versions    = viewMode === "releases" ? r.releases : r.tags;',
'    var latestLabel = r.latestRelease ? r.latestRelease.tag : (r.latestTag ? r.latestTag.name : null);',
'    var latestDisp  = isLatest ? (r.defaultBranch || "main") : latestLabel;',
'',
'    var statusBadge = "";',
'    if (!isLatest && r.installed && latestLabel) {',
'      var instClean   = r.installed.replace(/^v/, "");',
'      var latestClean = latestLabel.replace(/^v/, "");',
'      var cmp = semverCmp(instClean, latestClean);',
'      if (cmp === 0) {',
'        statusBadge = "<span class=\\"badge badge-latest\\">&#10003; up to date</span>";',
'      } else if (cmp > 0) {',
'        statusBadge = "<span class=\\"badge badge-newer\\">&#11015; ahead of remote</span>";',
'      } else {',
'        statusBadge = "<span class=\\"badge badge-update\\">&#8679; update available</span>";',
'      }',
'    } else if (isLatest && r.installed) {',
'      statusBadge = "<span class=\\"badge badge-release\\">&#9679; " + (r.defaultBranch || "main") + " ready</span>";',
'    }',
'',
'    var versionRow = "";',
'    if (r.installed || latestDisp) {',
'      versionRow = "<div class=\\"version-row\\">" +',
'        "<span class=\\"version-label\\">local:</span>" +',
'        "<span class=\\"version-value inst\\">" + (r.installed || "—") + "</span>" +',
'        "<span class=\\"version-arrow\\">&#10142;</span>" +',
'        "<span class=\\"version-label\\">" + (isLatest ? "target:" : "remote:") + "</span>" +',
'        "<span class=\\"version-value upstream\\">" + (latestDisp || "—") + "</span>" +',
'        "</div>";',
'    }',
'',
'    var selectOpts = (versions || []).map(function(v) {',
'      var lbl = viewMode === "releases" ? (v.tag + (v.prerelease ? " [pre]" : "")) : v.name;',
'      return "<option value=\\"" + (viewMode === "releases" ? v.tag : v.name) + "\\">" + lbl + "</option>";',
'    }).join("");',
'',
'    var actionsHtml = "";',
'    if (r.installed) {',
'      if (isLatest) {',
'        actionsHtml += "<button class=\\"btn btn-success\\" onclick=\\"doUpgrade(\'" + r.name + "\',\'" + r.adapterName + "\',true)\\">"+',
'          "&#9654; checkout " + (r.defaultBranch || "main") + "</button>";',
'      } else {',
'        actionsHtml += "<select class=\\"select-version\\" id=\\"sel-" + r.name + "\\">"+',
'          "<option value=\\"\\">-- tag w\u00e4hlen --</option>" + selectOpts + "</select>";',
'        actionsHtml += "<button class=\\"btn btn-success\\" onclick=\\"doUpgrade(\'" + r.name + "\',\'" + r.adapterName + "\')\\">" +',
'          "&#8679; upgrade / downgrade</button>";',
'      }',
'    } else {',
'      actionsHtml += "<button class=\\"btn btn-primary\\" onclick=\\"doInstallRepo(\'" + r.name + "\')\\">" +',
'        "&#9654; iobroker add</button>";',
'    }',
'    actionsHtml += "<a href=\\"" + r.url + "\\" target=\\"_blank\\" class=\\"btn btn-muted\\">&#128279; github</a>";',
'',
'    var updDate = r.updatedAt ? new Date(r.updatedAt).toLocaleDateString("de") : "";',
'    var branchChip = "<span class=\\"meta-chip\\">&#9095; " + (r.defaultBranch || "main") + "</span>";',
'    var starChip = r.stars ? "<span class=\\"meta-chip\\">&#9733; " + r.stars + "</span>" : "";',
'    var dateChip = updDate ? "<span class=\\"meta-chip\\">&#128197; " + updDate + "</span>" : "";',
'',
'    return "<div class=\\"repo-card " + statusCls + "\\">" +',
'      "<div class=\\"repo-card-inner\\">" +',
'      "<div class=\\"repo-header\\">" +',
'      "  <div class=\\"repo-icon\\">" + repoInitial(r.name) + "</div>" +',
'      "  <div style=\\"flex:1\\">" +',
'      "    <div class=\\"repo-name\\"><a href=\\"" + r.url + "\\" target=\\"_blank\\">" + r.name + "</a></div>" +',
'      "    <div class=\\"repo-desc\\">" + (r.description || "Keine Beschreibung") + "</div>" +',
'      "    <div class=\\"repo-meta\\">" + instBadge + " " + statusBadge + " " + branchChip + starChip + dateChip +',
'      "    </div>" +',
'      "  </div>" +',
'      "</div>" +',
'      versionRow +',
'      "<div class=\\"repo-actions\\">" + actionsHtml + "</div>" +',
'      "</div></div>";',
'  }).join("");',
'  el.innerHTML = html;',
'}',
'',
'// ── Upgrade / Downgrade ────────────────────────────────────────────────',
'window.doUpgrade = function(repoName, adapterName, forceLatest) {',
'  var sel = !forceLatest ? document.getElementById("sel-" + repoName) : null;',
'  var tag = (sel && sel.value) ? sel.value : null;',
'  var label = forceLatest ? "Latest (main)" : (tag ? tag : "neueste Version");',
'  if (!confirm("Adapter \\"" + adapterName + "\\" auf " + label + " aktualisieren?")) return;',
'  showTab("system");',
'  fetch("/api/upgrade", {',
'    method: "POST",',
'    headers: { "Content-Type": "application/json" },',
'    body: JSON.stringify({ repoName: repoName, adapterName: adapterName, tag: tag, forceLatest: !!forceLatest })',
'  }).then(function(r){ return r.json(); })',
'  .then(function(d){ addDebugLine("[UI] " + d.msg, "start"); })',
'  .catch(function(e){ addDebugLine("[UI] Fehler: " + e.message, "fail"); });',
'};',
'',
'// ── Install from Daten tab ────────────────────────────────────────────',
'window.doInstallRepo = function(repoName) {',
'  if (!confirm("Adapter \\"" + repoName + "\\" installieren?")) return;',
'  showTab("system");',
'  fetch("/api/install", {',
'    method: "POST",',
'    headers: { "Content-Type": "application/json" },',
'    body: JSON.stringify({ repoName: repoName })',
'  }).then(function(r){ return r.json(); })',
'  .then(function(d){ addDebugLine("[UI] " + d.msg, "start"); })',
'  .catch(function(e){ addDebugLine("[UI] Fehler: " + e.message, "fail"); });',
'};',
'',
'// ── Install from System tab ───────────────────────────────────────────',
'window.doInstall = function() {',
'  var sel = document.getElementById("installSelect");',
'  var repoName = sel ? sel.value : "";',
'  if (!repoName) { alert("Bitte einen Adapter w\u00e4hlen."); return; }',
'  if (!confirm("Adapter \\"" + repoName + "\\" installieren?")) return;',
'  fetch("/api/install", {',
'    method: "POST",',
'    headers: { "Content-Type": "application/json" },',
'    body: JSON.stringify({ repoName: repoName })',
'  }).then(function(r){ return r.json(); })',
'  .then(function(d){ addDebugLine("[UI] " + d.msg, "start"); })',
'  .catch(function(e){ addDebugLine("[UI] Fehler: " + e.message, "fail"); });',
'};',
'',
'function populateInstallSelect() {',
'  var sel = document.getElementById("installSelect");',
'  if (!sel) return;',
'  var not = repos.filter(function(r){ return !r.installed; });',
'  sel.innerHTML = "<option value=\\"\\">-- Adapter w\u00e4hlen (nur nicht installierte) --</option>" +',
'    not.map(function(r){ return "<option value=\\"" + r.name + "\\">" + r.name + "</option>"; }).join("");',
'}',
'',
'// ── Nodes Tab ─────────────────────────────────────────────────────────',
'function populateNodesSelect() {',
'  var sel = document.getElementById("nodesRepoSelect");',
'  if (!sel) return;',
'  var cur = sel.value;',
'  sel.innerHTML = "<option value=\\"\\">-- Repository w\u00e4hlen --</option>" +',
'    repos.map(function(r){ return "<option value=\\"" + r.name + "\\">" + r.name + "</option>"; }).join("");',
'  if (cur) sel.value = cur;',
'}',
'',
'window.loadNodes = function() {',
'  var sel  = document.getElementById("nodesRepoSelect");',
'  var name = sel ? sel.value : "";',
'  var grid = document.getElementById("nodesGrid");',
'  if (!name) {',
'    grid.innerHTML = "<div class=\\"empty-state\\" style=\\"grid-column:1/-1\\"><div class=\\"icon\\">&#128337;</div><p>Kein Repository ausgew\u00e4hlt.</p></div>";',
'    return;',
'  }',
'  var repo = repos.find(function(r){ return r.name === name; });',
'  if (!repo) { grid.innerHTML = "<p>Nicht gefunden.</p>"; return; }',
'',
'  var relHtml = (repo.releases && repo.releases.length)',
'    ? repo.releases.map(function(r) {',
'        return "<div class=\\"nodes-item\\">" +',
'          "<span style=\\"color:var(--cyan);font-size:10px\\">REL</span>" +',
'          "<span class=\\"nodes-item-name\\">" + r.tag + (r.prerelease ? " <span class=\\"badge badge-tag\\" style=\\"font-size:9px\\">pre</span>" : "") + "</span>" +',
'          "<span class=\\"nodes-item-meta\\">" + (r.date ? new Date(r.date).toLocaleDateString("de") : "") + "</span>" +',
'          "</div>";',
'      }).join("")',
'    : "<p style=\\"color:var(--text-muted);font-size:11px;font-family:var(--mono)\\">// keine releases</p>";',
'',
'  var tagHtml = (repo.tags && repo.tags.length)',
'    ? repo.tags.map(function(t) {',
'        return "<div class=\\"nodes-item\\">" +',
'          "<span style=\\"color:var(--purple);font-size:10px\\">TAG</span>" +',
'          "<span class=\\"nodes-item-name\\">" + t.name + "</span>" +',
'          "<span class=\\"nodes-item-meta sha\\">" + (t.sha || "") + "</span>" +',
'          "</div>";',
'      }).join("")',
'    : "<p style=\\"color:var(--text-muted);font-size:11px;font-family:var(--mono)\\">// keine tags</p>";',
'',
'  grid.innerHTML =',
'    "<div class=\\"nodes-card\\">" +',
'      "<h3>releases <span class=\\"count\\">" + (repo.releases ? repo.releases.length : 0) + "</span></h3>" +',
'      relHtml +',
'    "</div>" +',
'    "<div class=\\"nodes-card\\">" +',
'      "<h3>tags <span class=\\"count\\">" + (repo.tags ? repo.tags.length : 0) + "</span></h3>" +',
'      tagHtml +',
'    "</div>";',
'};',
'',
'// ── Logs ─────────────────────────────────────────────────────────────',
'function loadLogs() {',
'  fetch("/api/logs")',
'    .then(function(r){ return r.json(); })',
'    .then(function(d) {',
'      logData = d.logs || [];',
'      renderLogs();',
'    })',
'    .catch(function(e){ console.error(e); });',
'}',
'',
'function renderLogs() {',
'  var filter    = document.getElementById("logLevelFilter").value;',
'  var container = document.getElementById("logContainer");',
'  var filtered  = filter ? logData.filter(function(l){ return l.level === filter; }) : logData;',
'  if (!filtered.length) {',
'    container.innerHTML = "<div style=\\"padding:20px;text-align:center;color:var(--text-muted)\\">Keine Log-Eintr\u00e4ge.</div>";',
'    return;',
'  }',
'  container.innerHTML = filtered.map(function(l) {',
'    var t = new Date(l.ts).toLocaleTimeString("de");',
'    var lvlCls = "lvl-" + (l.level === "system" ? "system" : l.level);',
'    return "<div class=\\"log-entry\\">" +',
'      "<span class=\\"log-ts\\">" + t + "</span>" +',
'      "<span class=\\"log-level " + lvlCls + "\\">" + l.level.toUpperCase() + "</span>" +',
'      "<span class=\\"log-cat\\">" + (l.cat || "") + "</span>" +',
'      "<span class=\\"log-msg\\">" + esc(l.msg) + "</span>" +',
'      "</div>";',
'  }).join("");',
'  if (document.getElementById("autoScrollLog").checked) {',
'    container.scrollTop = container.scrollHeight;',
'  }',
'}',
'',
'function clearLogs() { logData = []; renderLogs(); }',
'',
'function exportLogs() {',
'  var txt = logData.map(function(l) {',
'    return new Date(l.ts).toISOString() + " [" + l.level.toUpperCase() + "] [" + l.cat + "] " + l.msg;',
'  }).join(String.fromCharCode(10));',
'  var a = document.createElement("a");',
'  a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(txt);',
'  a.download = "mbrepository-logs-" + Date.now() + ".txt";',
'  a.click();',
'}',
'',
'// ── Debug / Install Log ──────────────────────────────────────────────',
'function getDebugBody() { return document.getElementById("debugBody"); }',
'',
'function loadInstallLog() {',
'  fetch("/api/installlog")',
'    .then(function(r){ return r.json(); })',
'    .then(function(d) {',
'      var container = getDebugBody();',
'      var outer = document.getElementById("debugContainer");',
'      var lines = d.log || [];',
'      if (!container) return;',
'      container.innerHTML = lines.length',
'        ? lines.map(function(e){ return formatDebugLine(e.line); }).join("")',
'        : "<div style=\\"color:var(--text-muted);padding:4px 0\\">// keine ausgabe — starte eine installation</div>";',
'      if (document.getElementById("autoScrollDebug").checked && outer) {',
'        outer.scrollTop = outer.scrollHeight;',
'      }',
'    })',
'    .catch(function(e){ console.error(e); });',
'}',
'',
'function addDebugLine(line, cls) {',
'  var c = getDebugBody();',
'  var outer = document.getElementById("debugContainer");',
'  if (!c) return;',
'  var d = document.createElement("div");',
'  d.className = "debug-line " + (cls || "");',
'  d.textContent = line;',
'  c.appendChild(d);',
'  if (document.getElementById("autoScrollDebug").checked && outer) outer.scrollTop = outer.scrollHeight;',
'}',
'',
'function formatDebugLine(line) {',
'  var cls = "";',
'  if (line.startsWith("[CMD]"))     cls = "cmd";',
'  else if (line.startsWith("[SUCCESS]")) cls = "success";',
'  else if (line.startsWith("[FAIL]"))    cls = "fail";',
'  else if (line.startsWith("[STDERR]"))  cls = "stderr";',
'  else if (line.startsWith("[EXIT]"))    cls = "exit";',
'  else if (line.startsWith("[START]"))   cls = "start";',
'  return "<div class=\\"debug-line " + cls + "\\">" + esc(line) + "</div>";',
'}',
'',
'function clearInstallLog() {',
'  var c = getDebugBody();',
'  if (c) c.innerHTML = "<div style=\\"color:var(--text-muted);padding:4px 0\\">// konsole geleert</div>";',
'}',
'',
'// ── System: Self-Update ───────────────────────────────────────────────',
'window.checkSelfVersion = function() {',
'  fetch("/api/version")',
'    .then(function(r){ return r.json(); })',
'    .then(function(d) {',
'      document.getElementById("sysVerInst").textContent   = d.installed || "-";',
'      var errShort = d.error ? d.error.replace(/\\(https?:\\/\\/[^)]+\\)/g, "").trim() : null;',
'      document.getElementById("sysVerLatest").textContent = d.latest || (errShort ? "Fehler: " + errShort : "-");',
'      var btn = document.getElementById("btnSelfUpdate");',
'      if (d.latest && d.installed && d.latest !== ("v" + d.installed) && d.latest !== d.installed) {',
'        btn.style.display = "inline-flex";',
'      } else {',
'        btn.style.display = "none";',
'      }',
'    })',
'    .catch(function(e){ console.error(e); });',
'};',
'',
'window.doSelfUpdate = function() {',
'  if (!confirm("MBRepository Adapter aktualisieren?")) return;',
'  fetch("/api/selfupdate", { method: "POST" })',
'    .then(function(r){ return r.json(); })',
'    .then(function(d){ addDebugLine("[UI] " + d.msg, "start"); })',
'    .catch(function(e){ addDebugLine("[UI] Fehler: " + e.message, "fail"); });',
'};',
'',
'// ── Util ─────────────────────────────────────────────────────────────',
'function esc(s) {',
'  return String(s)',
'    .replace(/&/g,"&amp;").replace(/</g,"&lt;")',
'    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");',
'}',
'',
'// ── Init ─────────────────────────────────────────────────────────────',
'(function init() {',
'  document.getElementById("repoList").innerHTML =',
'    "<div class=\\"empty-state\\"><div class=\\"icon\\" style=\\"animation:spin 1.5s linear infinite;display:inline-block\\">&#8635;</div><p>$ connecting to adapter...</p></div>";',
'',
'  fetch("/api/repos")',
'    .then(function(r){ return r.json(); })',
'    .then(function(d) {',
'      if (d.scanError && (!d.repos || !d.repos.length)) {',
'        showScanError(d.scanError);',
'        document.getElementById("scanStatusText").textContent = "scan failed";',
'        document.getElementById("scanDot").style.background = "var(--red)";',
'      } else if (d.repos && d.repos.length) {',
'        repos = d.repos;',
'        renderRepoList();',
'        populateNodesSelect();',
'        populateInstallSelect();',
'        document.getElementById("headerSub").textContent = repos.length + " repos";',
'        document.getElementById("scanStatusText").textContent =',
'          "last scan: " + (d.lastScan ? new Date(d.lastScan).toLocaleTimeString("de") : "-");',
'        document.getElementById("sysLastScan").textContent = d.lastScan ? new Date(d.lastScan).toLocaleString("de") : "-";',
'        document.getElementById("sysRepoCount").textContent = repos.length;',
'      } else if (!d.scanning) {',
'        document.getElementById("repoList").innerHTML =',
'          "<div class=\\"empty-state\\"><div class=\\"icon\\" style=\\"animation:spin 1.5s linear infinite;display:inline-block\\">&#8635;</div><p>$ git fetch --auto</p></div>";',
'        doScan();',
'        return;',
'      }',
'      if (d.scanning) {',
'        document.getElementById("scanDot").classList.add("scanning");',
'        document.getElementById("scanStatusText").textContent = "scanning...";',
'        document.getElementById("repoList").innerHTML =',
'          "<div class=\\"empty-state\\"><div class=\\"icon\\" style=\\"animation:spin 1.5s linear infinite;display:inline-block\\">&#8635;</div><p>$ git fetch origin</p></div>";',
'        pollForScanComplete();',
'      }',
'    })',
'    .catch(function(e) {',
'      document.getElementById("repoList").innerHTML =',
'        "<div class=\\"empty-state\\"><div class=\\"icon\\">&#9888;&#65039;</div>" +',
'        "<p style=\\"color:var(--red)\\">connection error: " + esc(e.message) + "</p></div>";',
'      console.error("Init error:", e);',
'    });',
'})();',
'',
'function showScanError(msg) {',
'  document.getElementById("repoList").innerHTML =',
'    "<div class=\\"empty-state\\"><div class=\\"icon\\">&#9888;&#65039;</div>" +',
'    "<p style=\\"color:var(--red);margin-bottom:8px\\">// scan error</p>" +',
'    "<p style=\\"color:var(--text-muted);font-size:12px;max-width:600px;word-break:break-word;font-family:var(--mono)\\">" + esc(msg) + "</p>" +',
'    "<p style=\\"margin-top:12px;font-size:11px;color:var(--text-dim)\\">hint: set github token (60 req/h without)</p></div>";',
'}'
        ].join('\n');
    }
}

// Globales Sicherheitsnetz gegen unhandled rejections → kein Adapter-Absturz
process.on('unhandledRejection', (reason) => {
    console.error('[mbrepository] Unhandled Rejection (abgefangen):', reason && reason.message ? reason.message : String(reason));
});

const adapter = new MBRepository();
module.exports = adapter;
