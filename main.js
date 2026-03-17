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
            setTimeout(() => this.scanRepositories(), 3000);
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
            this.addLog('error', 'SCAN', 'Fehler beim Scannen: ' + e.message);
            throw e;
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
                        const ghUser  = this.config.githubUser || 'MPunktBPunkt';
                        const repoUrl = 'https://github.com/' + ghUser + '/' + repoName;
                        this.addInstallLog('[START] Installiere ' + repoName + '...');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, msg: 'Installation gestartet' }));
                        try {
                            await this.runCommand('add ' + repoUrl);
                            this.addLog('info', 'INSTALL', repoName + ' erfolgreich installiert');
                            this.addInstallLog('[SUCCESS] ' + repoName + ' installiert');
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
                        const { adapterName, repoName, tag } = JSON.parse(body);
                        const ghUser  = this.config.githubUser || 'MPunktBPunkt';
                        let repoUrl   = 'https://github.com/' + ghUser + '/' + repoName;
                        if (tag) repoUrl += '#' + tag;

                        this.addInstallLog('[START] Upgrade ' + adapterName + (tag ? ' -> ' + tag : ' -> latest') + '...');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, msg: 'Upgrade gestartet' }));

                        try {
                            await this.runCommand('upgrade ' + adapterName + ' ' + repoUrl);
                            this.addLog('info', 'UPGRADE', adapterName + ' erfolgreich aktualisiert');
                            this.addInstallLog('[SUCCESS] ' + adapterName + ' aktualisiert');
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
                this.runCommand(
                    'upgrade mbrepository https://github.com/' + ghUser + '/iobroker.mbrepository'
                ).then(() => {
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
'  --bg-primary:#0d1117;',
'  --bg-secondary:#161b22;',
'  --bg-card:#1c2128;',
'  --bg-hover:#21262d;',
'  --border:#30363d;',
'  --blue:#58a6ff;',
'  --blue-dim:#1f6feb;',
'  --green:#3fb950;',
'  --yellow:#d29922;',
'  --red:#f85149;',
'  --orange:#e3b341;',
'  --text:#e6edf3;',
'  --text-muted:#8b949e;',
'  --text-dim:#656d76;',
'  --radius:8px;',
'}',
'body{background:var(--bg-primary);color:var(--text);font-family:"Segoe UI",system-ui,sans-serif;font-size:14px;min-height:100vh}',
'header{background:var(--bg-secondary);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:100}',
'.logo{width:32px;height:32px;background:var(--blue-dim);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px}',
'.header-title{font-size:16px;font-weight:600;color:var(--text)}',
'.header-sub{font-size:12px;color:var(--text-muted);margin-left:auto}',
'.header-badge{background:var(--blue-dim);color:var(--blue);font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}',

'.tabs{background:var(--bg-secondary);border-bottom:1px solid var(--border);display:flex;gap:0;padding:0 20px}',
'.tab{padding:12px 18px;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-muted);font-size:13px;font-weight:500;transition:all .2s;background:none;border-left:none;border-right:none;border-top:none;outline:none}',
'.tab:hover{color:var(--text);background:var(--bg-hover)}',
'.tab.active{color:var(--blue);border-bottom-color:var(--blue)}',

'.content{padding:20px;max-width:1400px;margin:0 auto}',
'.tab-panel{display:none}.tab-panel.active{display:block}',

'.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}',
'.btn{padding:8px 16px;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:500;transition:all .2s;display:inline-flex;align-items:center;gap:6px}',
'.btn-primary{background:var(--blue-dim);color:var(--blue)}',
'.btn-primary:hover{background:#388bfd30;color:#79c0ff}',
'.btn-success{background:#1a3a1a;color:var(--green)}',
'.btn-success:hover{background:#2a4a2a}',
'.btn-warning{background:#3a2a00;color:var(--orange)}',
'.btn-warning:hover{background:#4a3a00}',
'.btn-danger{background:#3a1a1a;color:var(--red)}',
'.btn-danger:hover{background:#4a2a2a}',
'.btn-muted{background:var(--bg-hover);color:var(--text-muted)}',
'.btn-muted:hover{color:var(--text)}',
'.btn:disabled{opacity:0.4;cursor:not-allowed}',
'.btn.spin svg{animation:spin 1s linear infinite}',
'@keyframes spin{to{transform:rotate(360deg)}}',

'.toggle-group{display:flex;align-items:center;gap:8px;background:var(--bg-hover);border-radius:var(--radius);padding:4px}',
'.toggle-opt{padding:5px 12px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;color:var(--text-muted);transition:all .2s;border:none;background:none}',
'.toggle-opt.active{background:#388bfd;color:#ffffff;font-weight:600}',

'.scan-status{font-size:12px;color:var(--text-muted);margin-left:auto}',
'.scan-status .dot{width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block;margin-right:5px}',
'.scan-status .dot.scanning{background:var(--orange);animation:pulse .8s ease-in-out infinite}',
'@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}',

'.repo-list{display:flex;flex-direction:column;gap:12px}',
'.repo-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;transition:border-color .2s}',
'.repo-card:hover{border-color:var(--blue-dim)}',
'.repo-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}',
'.repo-icon{width:36px;height:36px;background:var(--blue-dim);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}',
'.repo-name{font-size:15px;font-weight:600;color:var(--blue)}',
'.repo-name a{color:inherit;text-decoration:none}',
'.repo-name a:hover{text-decoration:underline}',
'.repo-desc{font-size:12px;color:var(--text-muted);margin-top:2px}',
'.repo-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}',

'.badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;white-space:nowrap}',
'.badge-installed{background:#1f4a1f;color:#7ee787;border:1px solid #3fb95040}',
'.badge-not-installed{background:#2a2a2a;color:#aaaaaa;border:1px solid #44444440}',
'.badge-update{background:#4a2c00;color:#ffa657;border:1px solid #e3b34150}',
'.badge-newer{background:#0a2a3a;color:#79c0ff;border:1px solid #58a6ff50}',
'.badge-latest{background:#1f4a1f;color:#7ee787;border:1px solid #3fb95050}',
'.badge-release{background:#1a3060;color:#79c0ff;border:1px solid #58a6ff40}',
'.badge-tag{background:#2d1f50;color:#d2a8ff;border:1px solid #c084fc40}',

'.version-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:8px 0}',
'.version-label{font-size:12px;color:var(--text-muted)}',
'.version-value{font-size:13px;font-weight:600}',
'.version-arrow{color:var(--text-dim);font-size:14px}',

'.repo-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}',
'.select-version{background:var(--bg-hover);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12px;outline:none}',
'.select-version:focus{border-color:var(--blue-dim)}',

'.log-container{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);height:500px;overflow-y:auto;font-family:"Cascadia Code","Courier New",monospace;font-size:12px}',
'.log-entry{padding:4px 12px;border-bottom:1px solid #21262d;display:flex;gap:10px;align-items:flex-start}',
'.log-entry:hover{background:var(--bg-hover)}',
'.log-ts{color:var(--text-dim);white-space:nowrap;min-width:80px;font-size:11px;padding-top:1px}',
'.log-level{font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap;min-width:40px;text-align:center}',
'.log-cat{color:#c084fc;min-width:70px;font-size:11px}',
'.log-msg{color:var(--text);word-break:break-word;flex:1}',
'.lvl-info{background:#1a2a3a;color:var(--blue)}',
'.lvl-warn{background:#3a2a00;color:var(--orange)}',
'.lvl-error{background:#3a0d0d;color:var(--red)}',
'.lvl-debug{background:#1a1a2a;color:var(--text-muted)}',
'.lvl-system{background:#0a2a0a;color:var(--green)}',

'.debug-container{background:#0a0e14;border:1px solid var(--border);border-radius:var(--radius);height:500px;overflow-y:auto;font-family:"Cascadia Code","Courier New",monospace;font-size:12px;padding:8px 12px}',
'.debug-line{padding:2px 0;border-bottom:1px solid #111820;line-height:1.5}',
'.debug-line.cmd{color:#58a6ff}',
'.debug-line.success{color:var(--green)}',
'.debug-line.fail{color:var(--red)}',
'.debug-line.stderr{color:var(--yellow)}',
'.debug-line.exit{color:var(--text-muted);font-style:italic}',
'.debug-line.start{color:var(--orange)}',

'.nodes-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
'@media(max-width:900px){.nodes-grid{grid-template-columns:1fr}}',
'.nodes-select{background:var(--bg-hover);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 12px;font-size:13px;outline:none;width:300px}',
'.nodes-select:focus{border-color:var(--blue-dim)}',
'.nodes-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}',
'.nodes-card h3{font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:12px;display:flex;align-items:center;gap:6px}',
'.nodes-item{padding:8px 10px;border-radius:6px;display:flex;align-items:center;gap:8px;margin-bottom:4px;background:var(--bg-hover);cursor:default;transition:background .15s}',
'.nodes-item:hover{background:#21262d}',
'.nodes-item-name{flex:1;font-weight:500;font-size:13px}',
'.nodes-item-meta{font-size:11px;color:var(--text-dim)}',

'.system-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
'@media(max-width:900px){.system-grid{grid-template-columns:1fr}}',
'.system-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}',
'.system-card h3{font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:12px}',
'.info-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px}',
'.info-row:last-child{border-bottom:none}',
'.info-key{color:var(--text-muted)}',
'.info-val{color:var(--text);font-weight:500}',

'select option{background:var(--bg-card);color:var(--text)}',
'::-webkit-scrollbar{width:6px;height:6px}',
'::-webkit-scrollbar-track{background:var(--bg-secondary)}',
'::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}',
'::-webkit-scrollbar-thumb:hover{background:#484f58}',
'.empty-state{text-align:center;padding:60px 20px;color:var(--text-muted)}',
'.empty-state .icon{font-size:48px;margin-bottom:12px}',
'.empty-state p{font-size:14px}'
        ].join('\n');
    }

    getBodyHTML(v) {
        return [
'<header>',
'  <div class="logo">\u{1F4E6}</div>',
'  <div class="header-title">ioBroker MB Repository Manager</div>',
'  <span class="header-badge">v' + v + '</span>',
'  <div class="header-sub" id="headerSub">Bereit</div>',
'</header>',

'<div class="tabs">',
'  <button class="tab active" id="tab-data"    onclick="showTab(\'data\')">&#128202; Daten</button>',
'  <button class="tab"        id="tab-nodes"   onclick="showTab(\'nodes\')">&#128337; Nodes</button>',
'  <button class="tab"        id="tab-logs"    onclick="showTab(\'logs\')">&#128203; Logs</button>',
'  <button class="tab"        id="tab-system"  onclick="showTab(\'system\')">&#9881;&#65039; System</button>',
'</div>',

'<div class="content">',

// ── TAB: DATEN ──────────────────────────────────────────────────────────────
'<div class="tab-panel active" id="panel-data">',
'  <div class="toolbar">',
'    <button class="btn btn-primary" id="btnScan" onclick="doScan()">',
'      <svg id="scanIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
'      GitHub scannen',
'    </button>',
'    <div class="toggle-group">',
'      <button class="toggle-opt active" id="tog-releases" onclick="setToggle(\'releases\')">Nur Releases</button>',
'      <button class="toggle-opt"        id="tog-all"      onclick="setToggle(\'all\')">Alle Tags</button>',
'    </div>',
'    <div class="scan-status"><span class="dot" id="scanDot"></span><span id="scanStatusText">Kein Scan</span></div>',
'  </div>',
'  <div id="repoList" class="repo-list">',
'    <div class="empty-state"><div class="icon">&#128269;</div><p>Klicke auf "GitHub scannen" um Repositories zu laden.</p></div>',
'  </div>',
'</div>',

// ── TAB: NODES ──────────────────────────────────────────────────────────────
'<div class="tab-panel" id="panel-nodes">',
'  <div class="toolbar">',
'    <select class="nodes-select" id="nodesRepoSelect" onchange="loadNodes()">',
'      <option value="">-- Repository w\u00e4hlen --</option>',
'    </select>',
'    <button class="btn btn-muted" onclick="loadNodes()">&#8635; Laden</button>',
'  </div>',
'  <div class="nodes-grid" id="nodesGrid">',
'    <div class="empty-state" style="grid-column:1/-1"><div class="icon">&#128337;</div><p>Repository w\u00e4hlen um Releases und Tags anzuzeigen.</p></div>',
'  </div>',
'</div>',

// ── TAB: LOGS ───────────────────────────────────────────────────────────────
'<div class="tab-panel" id="panel-logs">',
'  <div class="toolbar">',
'    <button class="btn btn-muted"    onclick="loadLogs()">&#8635; Aktualisieren</button>',
'    <button class="btn btn-muted"    onclick="clearLogs()">&#128465; L\u00f6schen</button>',
'    <select id="logLevelFilter" style="background:var(--bg-hover);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 10px;font-size:12px" onchange="loadLogs()">',
'      <option value="">Alle Level</option>',
'      <option value="info">Info</option>',
'      <option value="warn">Warnung</option>',
'      <option value="error">Fehler</option>',
'      <option value="debug">Debug</option>',
'    </select>',
'    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);cursor:pointer">',
'      <input type="checkbox" id="autoScrollLog" checked> Auto-Scroll',
'    </label>',
'    <button class="btn btn-muted" onclick="exportLogs()">&#8659; Export</button>',
'  </div>',
'  <div class="log-container" id="logContainer"></div>',
'</div>',

// ── TAB: SYSTEM ─────────────────────────────────────────────────────────────
'<div class="tab-panel" id="panel-system">',
'  <div class="system-grid">',

'  <div class="system-card">',
'    <h3>&#128200; Adapter-Info</h3>',
'    <div id="adapterInfo">',
'      <div class="info-row"><span class="info-key">Version (installiert)</span><span class="info-val" id="sysVerInst">v' + v + '</span></div>',
'      <div class="info-row"><span class="info-key">Version (GitHub)</span><span class="info-val" id="sysVerLatest">-</span></div>',
'      <div class="info-row"><span class="info-key">Letzter Scan</span><span class="info-val" id="sysLastScan">-</span></div>',
'      <div class="info-row"><span class="info-key">Repositories gefunden</span><span class="info-val" id="sysRepoCount">-</span></div>',
'    </div>',
'    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">',
'      <button class="btn btn-primary" onclick="checkSelfVersion()">Auf Updates pr\u00fcfen</button>',
'      <button class="btn btn-success" id="btnSelfUpdate" style="display:none" onclick="doSelfUpdate()">Update installieren</button>',
'    </div>',
'  </div>',

'  <div class="system-card">',
'    <h3>&#128640; Neuen Adapter installieren</h3>',
'    <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Installiert einen Adapter direkt aus einem GitHub-Repository mit sudo-Rechten.</p>',
'    <select id="installSelect" class="select-version" style="width:100%;margin-bottom:10px">',
'      <option value="">-- Adapter w\u00e4hlen (nur nicht installierte) --</option>',
'    </select>',
'    <button class="btn btn-success" onclick="doInstall()" style="width:100%">',
'      &#128640; Adapter installieren',
'    </button>',
'  </div>',

'  </div>',

'  <div style="margin-top:16px">',
'    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">',
'      <h3 style="font-size:14px;font-weight:600">&#128421;&#65039; Installations-Konsole</h3>',
'      <button class="btn btn-muted" onclick="loadInstallLog()">&#8635;</button>',
'      <button class="btn btn-muted" onclick="clearInstallLog()">&#128465; Leeren</button>',
'      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);cursor:pointer">',
'        <input type="checkbox" id="autoScrollDebug" checked> Auto-Scroll',
'      </label>',
'    </div>',
'    <div class="debug-container" id="debugContainer"></div>',
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
'  document.getElementById("tog-all").classList.toggle("active",      mode === "all");',
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
'  document.getElementById("scanStatusText").textContent = "Scanne...";',
'  document.getElementById("headerSub").textContent = "Scan l\u00e4uft...";',
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
'            "Letzter Scan: " + (d.lastScan ? new Date(d.lastScan).toLocaleTimeString("de") : "-");',
'          document.getElementById("btnScan").disabled = false;',
'          document.getElementById("scanIcon").parentElement.classList.remove("spin");',
'          document.getElementById("headerSub").textContent = repos.length + " Repositories";',
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
'// ── Render Repo List ───────────────────────────────────────────────────',
'function renderRepoList() {',
'  var el = document.getElementById("repoList");',
'  if (!repos.length) {',
'    el.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icon\\">&#128269;</div><p>Keine Repositories gefunden.</p></div>";',
'    return;',
'  }',
'  var html = repos.map(function(r) {',
'    var instBadge = r.installed',
'      ? "<span class=\\"badge badge-installed\\">&#10003; v" + r.installed + " installiert</span>"',
'      : "<span class=\\"badge badge-not-installed\\">nicht installiert</span>";',
'',
'    var versions = viewMode === "releases" ? r.releases : r.tags;',
'    var latestLabel = r.latestRelease ? r.latestRelease.tag : (r.latestTag ? r.latestTag.name : null);',
'',
'    var statusBadge = "";',
'    if (r.installed && latestLabel) {',
'      var instClean   = r.installed.replace(/^v/, "");',
'      var latestClean = latestLabel.replace(/^v/, "");',
'      var cmp = semverCmp(instClean, latestClean);',
'      if (cmp === 0) {',
'        statusBadge = "<span class=\\"badge badge-latest\\">&#10003; Aktuell</span>";',
'      } else if (cmp > 0) {',
'        statusBadge = "<span class=\\"badge badge-newer\\">&#11015; Neuer als GitHub</span>";',
'      } else {',
'        statusBadge = "<span class=\\"badge badge-update\\">&#8679; Update verf\u00fcgbar</span>";',
'      }',
'    }',
'',
'    var versionRow = "";',
'    if (r.installed || latestLabel) {',
'      versionRow = "<div class=\\"version-row\\">" +',
'        "<span class=\\"version-label\\">Installiert:</span>" +',
'        "<span class=\\"version-value\\" style=\\"color:var(--green)\\">" + (r.installed || "\u2014") + "</span>" +',
'        "<span class=\\"version-arrow\\">&#10142;</span>" +',
'        "<span class=\\"version-label\\">Aktuell:</span>" +',
'        "<span class=\\"version-value\\" style=\\"color:var(--blue)\\">" + (latestLabel || "\u2014") + "</span>" +',
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
'      actionsHtml += "<select class=\\"select-version\\" id=\\"sel-" + r.name + "\\">" +',
'        "<option value=\\"\\">-- Version w\u00e4hlen --</option>" + selectOpts + "</select>";',
'      actionsHtml += "<button class=\\"btn btn-success\\" onclick=\\"doUpgrade(\'" + r.name + "\',\'" + r.adapterName + "\')\\">" +',
'        "&#8679; Upgrade / Downgrade</button>";',
'    } else {',
'      actionsHtml += "<button class=\\"btn btn-primary\\" onclick=\\"doInstallRepo(\'" + r.name + "\')\\">" +',
'        "&#128640; Installieren</button>";',
'    }',
'    actionsHtml += "<a href=\\"" + r.url + "\\" target=\\"_blank\\" class=\\"btn btn-muted\\">&#128279; GitHub</a>";',
'',
'    var updDate = r.updatedAt ? new Date(r.updatedAt).toLocaleDateString("de") : "";',
'',
'    return "<div class=\\"repo-card\\">" +',
'      "<div class=\\"repo-header\\">" +',
'      "  <div class=\\"repo-icon\\">&#128268;</div>" +',
'      "  <div style=\\"flex:1\\">" +',
'      "    <div class=\\"repo-name\\"><a href=\\"" + r.url + "\\" target=\\"_blank\\">" + r.name + "</a></div>" +',
'      "    <div class=\\"repo-desc\\">" + (r.description || "Keine Beschreibung") + "</div>" +',
'      "    <div class=\\"repo-meta\\">" + instBadge + " " + statusBadge +',
'      "      <span style=\\"font-size:11px;color:var(--text-dim)\\">&#128197; " + updDate + "</span>" +',
'      "    </div>" +',
'      "  </div>" +',
'      "</div>" +',
'      versionRow +',
'      "<div class=\\"repo-actions\\">" + actionsHtml + "</div>" +',
'      "</div>";',
'  }).join("");',
'  el.innerHTML = html;',
'}',
'',
'// ── Upgrade / Downgrade ────────────────────────────────────────────────',
'window.doUpgrade = function(repoName, adapterName) {',
'  var sel = document.getElementById("sel-" + repoName);',
'  var tag = sel ? sel.value : "";',
'  if (!confirm("Adapter \\"" + adapterName + "\\" " + (tag ? "auf " + tag + " " : "auf neueste Version ") + "aktualisieren?")) return;',
'  showTab("system");',
'  fetch("/api/upgrade", {',
'    method: "POST",',
'    headers: { "Content-Type": "application/json" },',
'    body: JSON.stringify({ repoName: repoName, adapterName: adapterName, tag: tag || null })',
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
'          "<span style=\\"font-size:16px\\">&#127381;</span>" +',
'          "<span class=\\"nodes-item-name\\">" + r.tag + (r.prerelease ? " <span class=\\"badge badge-tag\\" style=\\"font-size:10px\\">pre</span>" : "") + "</span>" +',
'          "<span class=\\"nodes-item-meta\\">" + (r.date ? new Date(r.date).toLocaleDateString("de") : "") + "</span>" +',
'          "</div>";',
'      }).join("")',
'    : "<p style=\\"color:var(--text-muted);font-size:12px\\">Keine Releases</p>";',
'',
'  var tagHtml = (repo.tags && repo.tags.length)',
'    ? repo.tags.map(function(t) {',
'        return "<div class=\\"nodes-item\\">" +',
'          "<span style=\\"font-size:16px\\">&#127991;&#65039;</span>" +',
'          "<span class=\\"nodes-item-name\\">" + t.name + "</span>" +',
'          "<span class=\\"nodes-item-meta\\">" + (t.sha || "") + "</span>" +',
'          "</div>";',
'      }).join("")',
'    : "<p style=\\"color:var(--text-muted);font-size:12px\\">Keine Tags</p>";',
'',
'  grid.innerHTML =',
'    "<div class=\\"nodes-card\\">" +',
'      "<h3>&#127381; Releases (" + (repo.releases ? repo.releases.length : 0) + ")</h3>" +',
'      relHtml +',
'    "</div>" +',
'    "<div class=\\"nodes-card\\">" +',
'      "<h3>&#127991;&#65039; Tags (" + (repo.tags ? repo.tags.length : 0) + ")</h3>" +',
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
'function loadInstallLog() {',
'  fetch("/api/installlog")',
'    .then(function(r){ return r.json(); })',
'    .then(function(d) {',
'      var container = document.getElementById("debugContainer");',
'      var lines = d.log || [];',
'      container.innerHTML = lines.length',
'        ? lines.map(function(e){ return formatDebugLine(e.line); }).join("")',
'        : "<div style=\\"color:var(--text-muted);padding:8px\\">Kein Ausgabe vorhanden. Starte eine Installation oder ein Upgrade.</div>";',
'      if (document.getElementById("autoScrollDebug").checked) {',
'        container.scrollTop = container.scrollHeight;',
'      }',
'    })',
'    .catch(function(e){ console.error(e); });',
'}',
'',
'function addDebugLine(line, cls) {',
'  var c = document.getElementById("debugContainer");',
'  var d = document.createElement("div");',
'  d.className = "debug-line " + (cls || "");',
'  d.textContent = line;',
'  c.appendChild(d);',
'  if (document.getElementById("autoScrollDebug").checked) c.scrollTop = c.scrollHeight;',
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
'  document.getElementById("debugContainer").innerHTML =',
'    "<div style=\\"color:var(--text-muted);padding:8px\\">Konsole geleert.</div>";',
'}',
'',
'// ── System: Self-Update ───────────────────────────────────────────────',
'window.checkSelfVersion = function() {',
'  fetch("/api/version")',
'    .then(function(r){ return r.json(); })',
'    .then(function(d) {',
'      document.getElementById("sysVerInst").textContent   = d.installed || "-";',
'      document.getElementById("sysVerLatest").textContent = d.latest    || (d.error ? "Fehler: " + d.error : "-");',
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
'    "<div class=\\"empty-state\\"><div class=\\"icon\\" style=\\"animation:spin 1.5s linear infinite;display:inline-block\\">&#8635;</div><p>Verbindung zum Adapter...</p></div>";',
'',
'  fetch("/api/repos")',
'    .then(function(r){ return r.json(); })',
'    .then(function(d) {',
'      if (d.scanError && (!d.repos || !d.repos.length)) {',
'        showScanError(d.scanError);',
'        document.getElementById("scanStatusText").textContent = "Scan fehlgeschlagen";',
'        document.getElementById("scanDot").style.background = "var(--red)";',
'      } else if (d.repos && d.repos.length) {',
'        repos = d.repos;',
'        renderRepoList();',
'        populateNodesSelect();',
'        populateInstallSelect();',
'        document.getElementById("headerSub").textContent = repos.length + " Repositories";',
'        document.getElementById("scanStatusText").textContent =',
'          "Letzter Scan: " + (d.lastScan ? new Date(d.lastScan).toLocaleTimeString("de") : "-");',
'        document.getElementById("sysLastScan").textContent = d.lastScan ? new Date(d.lastScan).toLocaleString("de") : "-";',
'        document.getElementById("sysRepoCount").textContent = repos.length;',
'      } else if (!d.scanning) {',
'        document.getElementById("repoList").innerHTML =',
'          "<div class=\\"empty-state\\"><div class=\\"icon\\" style=\\"animation:spin 1.5s linear infinite;display:inline-block\\">&#8635;</div><p>Scan wird gestartet...</p></div>";',
'        doScan();',
'        return;',
'      }',
'      if (d.scanning) {',
'        document.getElementById("scanDot").classList.add("scanning");',
'        document.getElementById("scanStatusText").textContent = "Scanne...";',
'        document.getElementById("repoList").innerHTML =',
'          "<div class=\\"empty-state\\"><div class=\\"icon\\" style=\\"animation:spin 1.5s linear infinite;display:inline-block\\">&#8635;</div><p>GitHub wird gescannt...</p></div>";',
'        pollForScanComplete();',
'      }',
'    })',
'    .catch(function(e) {',
'      document.getElementById("repoList").innerHTML =',
'        "<div class=\\"empty-state\\"><div class=\\"icon\\">&#9888;&#65039;</div>" +',
'        "<p style=\\"color:var(--red)\\">Verbindungsfehler: " + esc(e.message) + "</p></div>";',
'      console.error("Init error:", e);',
'    });',
'})();',
'',
'function showScanError(msg) {',
'  document.getElementById("repoList").innerHTML =',
'    "<div class=\\"empty-state\\"><div class=\\"icon\\">&#9888;&#65039;</div>" +',
'    "<p style=\\"color:var(--red);margin-bottom:8px\\">Scan-Fehler:</p>" +',
'    "<p style=\\"color:var(--text-muted);font-size:13px;max-width:600px;word-break:break-word\\">" + esc(msg) + "</p>" +',
'    "<p style=\\"margin-top:12px;font-size:12px;color:var(--text-dim)\\">Tipp: GitHub Token hinterlegen (60 Anfragen/h ohne Token)</p></div>";',
'}'
        ].join('\n');
    }
}

const adapter = new MBRepository();
module.exports = adapter;
