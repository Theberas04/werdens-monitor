'use strict';
// Werdens Monitor — eigen dashboard voor Werdens Media.
// Eén Node-proces, ingebouwde node:sqlite, geen npm-afhankelijkheden.
// Lezen kan alleen na inloggen; wijzigen kan alleen als beheerder.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const net = require('node:net');
const sqlite3 = require('node:sqlite');
const { URL } = require('node:url');
const { controleerSite, haalStats, scanHost } = require('./lib/checks');
const { haalProjecten } = require('./lib/github');

const POORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'monitor.db');
const DATA_MAP = path.dirname(DB_PATH);
const PUBLIC = path.join(__dirname, 'public');
const COOKIE = 'wm_sess';
const SESSIE_UREN = 12;
fs.mkdirSync(DATA_MAP, { recursive: true });

const db = new sqlite3.DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS instellingen(sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessies(token TEXT PRIMARY KEY, aangemaakt TEXT NOT NULL, verloopt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sites(
  id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, url TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '', stats_url TEXT NOT NULL DEFAULT '', interval_s INTEGER NOT NULL DEFAULT 60,
  actief INTEGER NOT NULL DEFAULT 1, aangemaakt TEXT NOT NULL, stats_json TEXT NOT NULL DEFAULT '', stats_op TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS controles(
  id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, op TEXT NOT NULL, ok INTEGER NOT NULL,
  code INTEGER, ms INTEGER, versie TEXT NOT NULL DEFAULT '', bytes INTEGER, tls_dagen INTEGER,
  titel TEXT NOT NULL DEFAULT '', fout TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_controles_site ON controles(site_id, op DESC);
CREATE TABLE IF NOT EXISTS projecten(
  naam TEXT PRIMARY KEY, url TEXT NOT NULL DEFAULT '', zichtbaarheid TEXT NOT NULL DEFAULT '', taal TEXT NOT NULL DEFAULT '',
  beschrijving TEXT NOT NULL DEFAULT '', versie TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '', commit_bericht TEXT NOT NULL DEFAULT '', commit_datum TEXT NOT NULL DEFAULT '',
  ci_status TEXT NOT NULL DEFAULT '', issues INTEGER NOT NULL DEFAULT 0, bijgewerkt TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '', fout TEXT NOT NULL DEFAULT '', opgehaald TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS hosts(ip TEXT PRIMARY KEY, naam TEXT NOT NULL DEFAULT '', notitie TEXT NOT NULL DEFAULT '',
  laatste_scan TEXT NOT NULL DEFAULT '', poorten TEXT NOT NULL DEFAULT '', diensten TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL DEFAULT '', titel TEXT NOT NULL, omschrijving TEXT NOT NULL DEFAULT '',
  prioriteit TEXT NOT NULL DEFAULT 'normaal', status TEXT NOT NULL DEFAULT 'open', aangemaakt TEXT NOT NULL,
  bijgewerkt TEXT NOT NULL, ai_onderzoek TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS berichten(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, auteur TEXT NOT NULL DEFAULT '',
  rol TEXT NOT NULL DEFAULT 'tom', bericht TEXT NOT NULL, op TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_berichten_ticket ON berichten(ticket_id, id);
`);

const nu = () => new Date().toISOString();
function instelling(sleutel, standaard = '') {
  const r = db.prepare('SELECT waarde FROM instellingen WHERE sleutel=?').get(sleutel);
  return r ? r.waarde : standaard;
}
function zetInstelling(sleutel, waarde) {
  db.prepare('INSERT INTO instellingen(sleutel,waarde) VALUES(?,?) ON CONFLICT(sleutel) DO UPDATE SET waarde=excluded.waarde')
    .run(sleutel, String(waarde));
}

// ── beheerder ────────────────────────────────────────────────────────────────
const scrypt = (wachtwoord, zout) => crypto.scryptSync(String(wachtwoord), zout, 64).toString('hex');
function wachtwoordAfdruk(wachtwoord) {
  const zout = crypto.randomBytes(16).toString('hex');
  return zout + ':' + scrypt(wachtwoord, zout);
}
function wachtwoordKlopt(wachtwoord, afdruk) {
  const [zout, hash] = String(afdruk || '').split(':');
  if (!zout || !hash) return false;
  const berekend = Buffer.from(scrypt(wachtwoord, zout), 'hex');
  const bewaard = Buffer.from(hash, 'hex');
  return berekend.length === bewaard.length && crypto.timingSafeEqual(berekend, bewaard);
}

if (!instelling('admin_hash')) {
  const wachtwoord = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  zetInstelling('admin_hash', wachtwoordAfdruk(wachtwoord));
  zetInstelling('admin_naam', process.env.ADMIN_NAAM || 'tom');
  if (!process.env.ADMIN_PASSWORD) {
    const bestand = path.join(DATA_MAP, 'admin-wachtwoord.txt');
    fs.writeFileSync(bestand, wachtwoord + '\n', { mode: 0o600 });
    console.log('Beheerderswachtwoord aangemaakt: ' + bestand);
  }
}
if (!instelling('agent_token')) zetInstelling('agent_token', crypto.randomBytes(24).toString('hex'));

// ── sessies ──────────────────────────────────────────────────────────────────
const sessies = {
  maak() {
    const token = crypto.randomBytes(32).toString('hex');
    const verloopt = new Date(Date.now() + SESSIE_UREN * 3600e3).toISOString();
    db.prepare('INSERT INTO sessies(token,aangemaakt,verloopt) VALUES(?,?,?)').run(token, nu(), verloopt);
    return token;
  },
  geldig(token) {
    if (!token) return false;
    const r = db.prepare('SELECT verloopt FROM sessies WHERE token=?').get(token);
    if (!r) return false;
    if (r.verloopt < nu()) { db.prepare('DELETE FROM sessies WHERE token=?').run(token); return false; }
    return true;
  },
  wis(token) { if (token) db.prepare('DELETE FROM sessies WHERE token=?').run(token); },
};

function koekjes(req) {
  const uit = {};
  for (const deel of String(req.headers.cookie || '').split(';')) {
    const i = deel.indexOf('=');
    if (i > 0) uit[deel.slice(0, i).trim()] = decodeURIComponent(deel.slice(i + 1).trim());
  }
  return uit;
}

function isBeheerder(req) {
  return sessies.geldig(koekjes(req)[COOKIE]);
}

// ── antwoorden ───────────────────────────────────────────────────────────────
function stuur(res, code, inhoud, koppen = {}) {
  res.writeHead(code, koppen);
  res.end(inhoud);
}
function json(res, code, data, extraKoppen = {}) {
  const tekst = JSON.stringify(data);
  const koppen = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraKoppen };
  const gzip = String(res.req.headers['accept-encoding'] || '').includes('gzip') && tekst.length > 800;
  const doel = gzip ? zlib.gzipSync(tekst) : Buffer.from(tekst);
  if (gzip) koppen['content-encoding'] = 'gzip';
  koppen['content-length'] = doel.length;
  stuur(res, code, doel, koppen);
}
function fout(res, code, melding) { json(res, code, { fout: melding }); }

function leesBody(req) {
  return new Promise((resolve, reject) => {
    let lengte = 0;
    const brokken = [];
    req.on('data', (c) => {
      lengte += c.length;
      if (lengte > 1_000_000) { reject(new Error('Verzoek te groot')); req.destroy(); return; }
      brokken.push(c);
    });
    req.on('end', () => {
      const tekst = Buffer.concat(brokken).toString('utf8');
      if (!tekst) return resolve({});
      try { resolve(JSON.parse(tekst)); } catch { reject(new Error('Ongeldige JSON')); }
    });
    req.on('error', reject);
  });
}

const tekst = (v, max = 200) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// Alleen echte IPv4/IPv6-adressen; "999.1.1.1" moet geweigerd worden.
function geldigIp(waarde) {
  const s = String(waarde || '').trim();
  if (net.isIP(s)) return true;
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((n) => Number(n) >= 0 && Number(n) <= 255);
}

// ── projecten ────────────────────────────────────────────────────────────────
const projecten = {
  lijst() {
    return db.prepare('SELECT * FROM projecten ORDER BY bijgewerkt DESC').all();
  },
  bewaar(lijst) {
    const op = nu();
    const zet = db.prepare(`INSERT INTO projecten(naam,url,zichtbaarheid,taal,beschrijving,versie,tag,commit_sha,commit_bericht,
      commit_datum,ci_status,issues,bijgewerkt,branch,fout,opgehaald) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(naam) DO UPDATE SET url=excluded.url,zichtbaarheid=excluded.zichtbaarheid,taal=excluded.taal,
      beschrijving=excluded.beschrijving,versie=excluded.versie,tag=excluded.tag,commit_sha=excluded.commit_sha,
      commit_bericht=excluded.commit_bericht,commit_datum=excluded.commit_datum,ci_status=excluded.ci_status,
      issues=excluded.issues,bijgewerkt=excluded.bijgewerkt,branch=excluded.branch,fout=excluded.fout,opgehaald=excluded.opgehaald`);
    db.exec('BEGIN');
    try {
      for (const p of lijst) zet.run(p.naam, p.url || '', p.zichtbaarheid || '', p.taal || '', p.beschrijving || '',
        p.versie || '', p.tag || '', p.commit_sha || '', p.commit_bericht || '', p.commit_datum || '',
        p.ci_status || '', p.issues || 0, p.bijgewerkt || '', p.standaard_branch || '', p.fout || '', op);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    zetInstelling('projecten_op', op);
  },
  async ververs() {
    const lijst = await haalProjecten();
    this.bewaar(lijst);
    return lijst;
  },
};

// ── sites ────────────────────────────────────────────────────────────────────
const sites = {
  lijst() { return db.prepare('SELECT * FROM sites ORDER BY naam COLLATE NOCASE').all(); },
  een(id) { return db.prepare('SELECT * FROM sites WHERE id=?').get(Number(id)); },
  laatste(siteId) { return db.prepare('SELECT * FROM controles WHERE site_id=? ORDER BY id DESC LIMIT 1').get(siteId); },
  geschiedenis(siteId, aantal = 60) {
    return db.prepare('SELECT op,ok,ms,code FROM controles WHERE site_id=? ORDER BY id DESC LIMIT ?').all(siteId, aantal).reverse();
  },
  uptime(siteId, uren = 24) {
    const grens = new Date(Date.now() - uren * 3600e3).toISOString();
    const r = db.prepare('SELECT COUNT(*) n, SUM(ok) goed FROM controles WHERE site_id=? AND op>=?').get(siteId, grens);
    if (!r || !r.n) return null;
    return Math.round((r.goed || 0) / r.n * 1000) / 10;
  },
};

async function meetSite(site) {
  const meting = await controleerSite(site);
  let stats = null;
  if (site.stats_url) {
    stats = await haalStats(site.stats_url);
    if (stats) {
      db.prepare('UPDATE sites SET stats_json=?, stats_op=? WHERE id=?').run(JSON.stringify(stats), meting.op, site.id);
      if (!meting.versie && stats.versie) meting.versie = stats.versie;
    }
  }
  if (!meting.versie && site.repo) {
    const p = db.prepare('SELECT versie FROM projecten WHERE naam=?').get(site.repo);
    if (p && p.versie) meting.versie = p.versie;
  }
  db.prepare(`INSERT INTO controles(site_id,op,ok,code,ms,versie,bytes,tls_dagen,titel,fout)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(site.id, meting.op, meting.ok, meting.code, meting.ms,
    meting.versie || '', meting.bytes, meting.tls_dagen, meting.titel || '', meting.fout || '');
  return meting;
}

function siteBeeld(site, metGeschiedenis = false) {
  const laatste = sites.laatste(site.id);
  let stats = null;
  try { stats = site.stats_json ? JSON.parse(site.stats_json) : null; } catch { stats = null; }
  return {
    id: site.id, naam: site.naam, url: site.url, ip: site.ip, repo: site.repo,
    stats_url: site.stats_url, interval_s: site.interval_s, actief: !!site.actief,
    laatste: laatste || null, uptime24: sites.uptime(site.id), stats, stats_op: site.stats_op || '',
    geschiedenis: metGeschiedenis ? sites.geschiedenis(site.id) : undefined,
  };
}

function siteVanBody(body, bestaand = null) {
  const naam = tekst(body.naam, 80) || (bestaand && bestaand.naam);
  let url = tekst(body.url, 400) || (bestaand && bestaand.url);
  if (!naam) throw new Error('Naam is verplicht');
  if (!url) throw new Error('URL is verplicht');
  const schema = url.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schema && !/^https?$/i.test(schema[1])) throw new Error('Alleen http- en https-adressen');
  if (!schema) url = 'http://' + url;
  let u;
  try { u = new URL(url); } catch { throw new Error('Ongeldige URL'); }
  if (!u.hostname) throw new Error('Ongeldige URL');
  const interval = Math.min(86400, Math.max(30, Number(body.interval_s) || (bestaand && bestaand.interval_s) || 60));
  let statsUrl = tekst(body.stats_url, 400);
  if (statsUrl && !/^https?:\/\//i.test(statsUrl)) statsUrl = 'http://' + statsUrl;
  if (statsUrl) { try { new URL(statsUrl); } catch { throw new Error('Ongeldig stats-adres'); } }
  const repo = tekst(body.repo, 100).replace(/^.*github\.com\//i, '').replace(/\/.*$/, '');
  return {
    naam, url: u.toString(), ip: tekst(body.ip, 60) || (bestaand && bestaand.ip) || '',
    repo, stats_url: statsUrl, interval_s: interval,
    actief: body.actief === undefined ? (bestaand ? bestaand.actief : 1) : (body.actief ? 1 : 0),
  };
}

// ── tickets ──────────────────────────────────────────────────────────────────
const STATUSSEN = ['open', 'in behandeling', 'wacht op Tom', 'opgelost', 'gesloten'];
const PRIORITEITEN = ['laag', 'normaal', 'hoog', 'kritiek'];

const tickets = {
  lijst(where = '', params = []) {
    return db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM berichten b WHERE b.ticket_id=t.id) berichten
      FROM tickets t ${where} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in behandeling' THEN 1
      WHEN 'wacht op Tom' THEN 2 WHEN 'opgelost' THEN 3 ELSE 4 END,
      CASE t.prioriteit WHEN 'kritiek' THEN 0 WHEN 'hoog' THEN 1 WHEN 'normaal' THEN 2 ELSE 3 END, t.id DESC`).all(...params);
  },
  een(id) { return db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(id)); },
  berichten(id) { return db.prepare('SELECT * FROM berichten WHERE ticket_id=? ORDER BY id').all(Number(id)); },
  voegBerichtToe(id, auteur, rol, bericht) {
    db.prepare('INSERT INTO berichten(ticket_id,auteur,rol,bericht,op) VALUES(?,?,?,?,?)')
      .run(Number(id), auteur.slice(0, 60), rol, bericht.slice(0, 4000), nu());
    db.prepare('UPDATE tickets SET bijgewerkt=? WHERE id=?').run(nu(), Number(id));
  },
  context(ticket) {
    const host = ticket.ip ? db.prepare('SELECT * FROM hosts WHERE ip=?').get(ticket.ip) : null;
    let poorten = [];
    let diensten = [];
    try { poorten = host && host.poorten ? JSON.parse(host.poorten) : []; } catch { poorten = []; }
    try { diensten = host && host.diensten ? JSON.parse(host.diensten) : []; } catch { diensten = []; }
    const passendeSites = sites.lijst().filter((s) => s.ip === ticket.ip || (s.url || '').includes(ticket.ip)).map((s) => {
      const l = sites.laatste(s.id);
      return { naam: s.naam, url: s.url, ok: l ? !!l.ok : null, code: l && l.code, ms: l && l.ms, versie: l && l.versie, op: l && l.op };
    });
    return {
      ip: ticket.ip, host: host ? { naam: host.naam, notitie: host.notitie, laatste_scan: host.laatste_scan, poorten, diensten } : null,
      sites: passendeSites,
      projecten: db.prepare('SELECT naam,versie,commit_sha,ci_status,bijgewerkt FROM projecten ORDER BY bijgewerkt DESC LIMIT 20').all(),
    };
  },
};

function ticketVanBody(body) {
  const titel = tekst(body.titel, 120);
  if (!titel) throw new Error('Titel is verplicht');
  const ip = tekst(body.ip, 60);
  if (ip && !geldigIp(ip)) throw new Error('Geen geldig IP-adres');
  const prioriteit = PRIORITEITEN.includes(body.prioriteit) ? body.prioriteit : 'normaal';
  const status = STATUSSEN.includes(body.status) ? body.status : 'open';
  return { titel, ip, omschrijving: tekst(body.omschrijving, 4000), prioriteit, status };
}

// ── achtergrondwerk ──────────────────────────────────────────────────────────
let meetBezig = false;
async function meetRonde() {
  if (meetBezig) return;
  meetBezig = true;
  try {
    for (const site of sites.lijst()) {
      if (!site.actief) continue;
      const laatste = sites.laatste(site.id);
      const volgende = laatste ? new Date(laatste.op).getTime() + site.interval_s * 1000 : 0;
      if (Date.now() < volgende) continue;
      try { await meetSite(site); } catch (e) { console.error('Meting mislukt voor ' + site.naam + ': ' + e.message); }
    }
    db.prepare("DELETE FROM controles WHERE op < ?").run(new Date(Date.now() - 30 * 86400e3).toISOString());
  } finally { meetBezig = false; }
}

let ververstBezig = false;
async function verversProjecten() {
  if (ververstBezig) return;
  ververstBezig = true;
  try { await projecten.ververs(); zetInstelling('projecten_fout', ''); }
  catch (e) { zetInstelling('projecten_fout', e.message); }
  finally { ververstBezig = false; }
}

// ── routes ───────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function statisch(req, res, pad) {
  let schoon = decodeURIComponent(pad.split('?')[0]);
  if (schoon.endsWith('/')) schoon += 'index.html';
  if (schoon.includes('\0') || schoon.split('/').includes('..')) return stuur(res, 403, 'Verboden');
  const bestand = path.join(PUBLIC, schoon);
  if (!bestand.startsWith(PUBLIC)) return stuur(res, 403, 'Verboden');
  const ext = path.extname(bestand).toLowerCase();
  if (!MIME[ext]) return stuur(res, 404, 'Niet gevonden');
  fs.readFile(bestand, (err, data) => {
    if (err) return stuur(res, 404, 'Niet gevonden');
    stuur(res, 200, data, {
      'content-type': MIME[ext],
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'x-werdensmonitor': 'app',
    });
  });
}

function overzicht() {
  const siteLijst = sites.lijst().map((s) => ({ ...siteBeeld(s), geschiedenis: sites.geschiedenis(s.id, 26) }));
  const ticketLijst = tickets.lijst();
  const open = ticketLijst.filter((t) => ['open', 'in behandeling', 'wacht op Tom'].includes(t.status));
  const neer = siteLijst.filter((s) => s.actief && (!s.laatste || !s.laatste.ok));
  const projectenLijst = projecten.lijst();
  const weekGrens = Date.now() - 7 * 86400e3;
  return {
    samenvatting: {
      sites: siteLijst.length, sites_ok: siteLijst.length - neer.length, sites_neer: neer.length,
      projecten: projectenLijst.length,
      projecten_actief: projectenLijst.filter((p) => p.commit_datum && new Date(p.commit_datum).getTime() > weekGrens).length,
      projecten_ci_fout: projectenLijst.filter((p) => p.ci_status === 'failure').length,
      tickets_open: open.length, tickets_kritiek: open.filter((t) => t.prioriteit === 'kritiek').length,
      laatste_meting: siteLijst.reduce((a, s) => (s.laatste && s.laatste.op > a ? s.laatste.op : a), ''),
      projecten_op: instelling('projecten_op'), projecten_fout: instelling('projecten_fout'),
    },
    sites: siteLijst, tickets: open.slice(0, 6), projecten: projectenLijst.slice(0, 6),
  };
}

async function verwerk(req, res) {
  const ruwe = String(req.url || '/');
  let url;
  try {
    url = new URL(ruwe.startsWith('//') ? ruwe.replace(/^\/+/, '/') : ruwe, 'http://monitor.local');
  } catch { return fout(res, 400, 'Ongeldig verzoek'); }
  const pad = url.pathname;
  const methode = req.method;
  const delen = pad.split('/').filter(Boolean);

  // openbare routes
  if (pad === '/healthz') return stuur(res, 200, 'ok', { 'content-type': 'text/plain', 'x-werdensmonitor': 'app', 'cache-control': 'no-store' });
  if (pad === '/api/login' && methode === 'POST') {
    const body = await leesBody(req).catch(() => ({}));
    if (!wachtwoordKlopt(body.wachtwoord || '', instelling('admin_hash'))) {
      await new Promise((r) => setTimeout(r, 400));
      return fout(res, 401, 'Onjuist wachtwoord');
    }
    const token = sessies.maak();
    const koek = `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSIE_UREN * 3600}`;
    return json(res, 200, { ok: true, naam: instelling('admin_naam', 'tom') }, { 'set-cookie': koek });
  }

  // agent-API: alleen tickets, met een eigen token, geen beheerderssessie nodig
  if (delen[1] === 'agent') {
    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token || token !== instelling('agent_token')) return fout(res, 401, 'Ongeldig agent-token');
    return agentRoutes(req, res, delen, url);
  }

  if (!isBeheerder(req)) {
    if (pad.startsWith('/api/')) return fout(res, 401, 'Niet ingelogd');
    if (methode === 'GET' || methode === 'HEAD') {
      // de pagina zelf is de inlogpagina; de app verbergt alles tot je inlogt
      if (pad === '/' || pad === '/index.html') return statisch(req, res, '/index.html');
      return stuur(res, 302, '', { location: '/' });
    }
    return fout(res, 401, 'Niet ingelogd');
  }

  if (pad === '/api/ik' && methode === 'GET') return json(res, 200, { naam: instelling('admin_naam', 'tom') });
  if (pad === '/api/logout' && methode === 'POST') { sessies.wis(koekjes(req)[COOKIE]); return json(res, 200, { ok: true }); }
  if (pad === '/api/overzicht' && methode === 'GET') return json(res, 200, overzicht());

  if (pad === '/api/projecten' && methode === 'GET') {
    return json(res, 200, { projecten: projecten.lijst(), op: instelling('projecten_op'), fout: instelling('projecten_fout') });
  }
  if (pad === '/api/projecten/verversen' && methode === 'POST') {
    const laatste = instelling('projecten_op');
    if (laatste && Date.now() - new Date(laatste).getTime() < 60e3 && !ververstBezig) {
      return json(res, 200, { projecten: projecten.lijst(), op: laatste, fout: instelling('projecten_fout'), overgeslagen: true });
    }
    try { await projecten.ververs(); zetInstelling('projecten_fout', ''); }
    catch (e) { zetInstelling('projecten_fout', e.message); return fout(res, 502, e.message); }
    return json(res, 200, { projecten: projecten.lijst(), op: instelling('projecten_op'), fout: '' });
  }

  if (pad === '/api/sites' && methode === 'GET') return json(res, 200, { sites: sites.lijst().map((s) => siteBeeld(s)) });
  if (pad === '/api/sites' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    try {
      const s = siteVanBody(body);
      const r = db.prepare(`INSERT INTO sites(naam,url,ip,repo,stats_url,interval_s,actief,aangemaakt) VALUES(?,?,?,?,?,?,?,?)`)
        .run(s.naam, s.url, s.ip, s.repo, s.stats_url, s.interval_s, s.actief, nu());
      const site = sites.een(r.lastInsertRowid);
      meetSite(site).catch(() => {});
      return json(res, 201, { site: siteBeeld(site) });
    } catch (e) { return fout(res, 400, e.message); }
  }
  if (delen[1] === 'sites' && delen[2]) {
    const site = sites.een(delen[2]);
    if (!site) return fout(res, 404, 'Site niet gevonden');
    if (methode === 'GET' && !delen[3]) {
      return json(res, 200, {
        site: siteBeeld(site, true),
        controles: db.prepare('SELECT * FROM controles WHERE site_id=? ORDER BY id DESC LIMIT 100').all(site.id),
      });
    }
    if (methode === 'PATCH' && !delen[3]) {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      try {
        const s = siteVanBody({ ...site, ...body }, site);
        db.prepare('UPDATE sites SET naam=?,url=?,ip=?,repo=?,stats_url=?,interval_s=?,actief=? WHERE id=?')
          .run(s.naam, s.url, s.ip, s.repo, s.stats_url, s.interval_s, s.actief, site.id);
        return json(res, 200, { site: siteBeeld(sites.een(site.id)) });
      } catch (e) { return fout(res, 400, e.message); }
    }
    if (methode === 'DELETE' && !delen[3]) {
      db.prepare('DELETE FROM controles WHERE site_id=?').run(site.id);
      db.prepare('DELETE FROM sites WHERE id=?').run(site.id);
      return json(res, 200, { ok: true });
    }
    if (methode === 'POST' && delen[3] === 'controleer') {
      const meting = await meetSite(site);
      return json(res, 200, { meting, site: siteBeeld(sites.een(site.id), true) });
    }
  }

  if (pad === '/api/tickets' && methode === 'GET') {
    return json(res, 200, { tickets: tickets.lijst(), statussen: STATUSSEN, prioriteiten: PRIORITEITEN });
  }
  if (pad === '/api/tickets' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    let t;
    try { t = ticketVanBody(body); } catch (e) { return fout(res, 400, e.message); }
    const r = db.prepare(`INSERT INTO tickets(ip,titel,omschrijving,prioriteit,status,aangemaakt,bijgewerkt)
      VALUES(?,?,?,?,?,?,?)`).run(t.ip, t.titel, t.omschrijving, t.prioriteit, t.status, nu(), nu());
    const ticket = tickets.een(r.lastInsertRowid);
    if (t.omschrijving) tickets.voegBerichtToe(ticket.id, 'Tom', 'tom', t.omschrijving);
    return json(res, 201, { ticket });
  }
  if (delen[1] === 'tickets' && delen[2]) {
    const ticket = tickets.een(delen[2]);
    if (!ticket) return fout(res, 404, 'Ticket niet gevonden');
    if (methode === 'GET' && !delen[3]) {
      return json(res, 200, { ticket, berichten: tickets.berichten(ticket.id), context: tickets.context(ticket) });
    }
    if (methode === 'PATCH' && !delen[3]) {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      const velden = [];
      const waarden = [];
      if (body.status !== undefined) {
        if (!STATUSSEN.includes(body.status)) return fout(res, 400, 'Onbekende status');
        velden.push('status=?'); waarden.push(body.status);
      }
      if (body.prioriteit !== undefined) {
        if (!PRIORITEITEN.includes(body.prioriteit)) return fout(res, 400, 'Onbekende prioriteit');
        velden.push('prioriteit=?'); waarden.push(body.prioriteit);
      }
      if (body.titel !== undefined) { const t = tekst(body.titel, 120); if (!t) return fout(res, 400, 'Titel is verplicht'); velden.push('titel=?'); waarden.push(t); }
      if (body.ai_onderzoek !== undefined) { velden.push('ai_onderzoek=?'); waarden.push(tekst(body.ai_onderzoek, 8000)); }
      if (!velden.length) return fout(res, 400, 'Niets te wijzigen');
      velden.push('bijgewerkt=?'); waarden.push(nu()); waarden.push(ticket.id);
      db.prepare('UPDATE tickets SET ' + velden.join(',') + ' WHERE id=?').run(...waarden);
      return json(res, 200, { ticket: tickets.een(ticket.id) });
    }
    if (methode === 'POST' && delen[3] === 'berichten') {
      const body = await leesBody(req).catch(() => null);
      const bericht = tekst(body && body.bericht, 4000);
      if (!bericht) return fout(res, 400, 'Bericht is leeg');
      const rol = body.rol === 'agent' ? 'agent' : 'tom';
      tickets.voegBerichtToe(ticket.id, rol === 'agent' ? 'AI-agent' : 'Tom', rol, bericht);
      if (body.status && STATUSSEN.includes(body.status)) {
        db.prepare('UPDATE tickets SET status=? WHERE id=?').run(body.status, ticket.id);
      }
      return json(res, 201, { ticket: tickets.een(ticket.id), berichten: tickets.berichten(ticket.id) });
    }
    if (methode === 'DELETE' && !delen[3]) {
      db.prepare('DELETE FROM berichten WHERE ticket_id=?').run(ticket.id);
      db.prepare('DELETE FROM tickets WHERE id=?').run(ticket.id);
      return json(res, 200, { ok: true });
    }
  }

  if (pad === '/api/hosts/scan' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    try {
      const uit = await scanHost(body.ip);
      db.prepare(`INSERT INTO hosts(ip,naam,notitie,laatste_scan,poorten,diensten) VALUES(?,?,?,?,?,?)
        ON CONFLICT(ip) DO UPDATE SET laatste_scan=excluded.laatste_scan,poorten=excluded.poorten,diensten=excluded.diensten,
        naam=CASE WHEN excluded.naam<>'' THEN excluded.naam ELSE hosts.naam END`)
        .run(uit.ip, tekst(body.naam, 60), tekst(body.notitie, 200), uit.op, JSON.stringify(uit.poorten), JSON.stringify(uit.diensten));
      return json(res, 200, { scan: uit, host: db.prepare('SELECT * FROM hosts WHERE ip=?').get(uit.ip) });
    } catch (e) { return fout(res, 400, e.message); }
  }
  if (pad === '/api/hosts' && methode === 'GET') {
    return json(res, 200, { hosts: db.prepare('SELECT * FROM hosts ORDER BY laatste_scan DESC').all() });
  }

  if (pad === '/api/instellingen' && methode === 'GET') {
    return json(res, 200, {
      admin_naam: instelling('admin_naam', 'tom'),
      agent_token: instelling('agent_token'),
      projecten_op: instelling('projecten_op'),
      projecten_fout: instelling('projecten_fout'),
      github_token: process.env.GITHUB_TOKEN ? 'ingesteld via omgeving' : 'niet ingesteld',
      versie: require('./package.json').version,
    });
  }
  if (pad === '/api/instellingen' && methode === 'PATCH') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    if (body.wachtwoord) {
      if (String(body.wachtwoord).length < 8) return fout(res, 400, 'Wachtwoord moet minstens 8 tekens hebben');
      if (!wachtwoordKlopt(body.huidig_wachtwoord || '', instelling('admin_hash'))) return fout(res, 401, 'Huidig wachtwoord onjuist');
      zetInstelling('admin_hash', wachtwoordAfdruk(body.wachtwoord));
      db.prepare('DELETE FROM sessies').run();
      return json(res, 200, { ok: true, opnieuw_inloggen: true });
    }
    if (body.agent_token === 'nieuw') {
      zetInstelling('agent_token', crypto.randomBytes(24).toString('hex'));
    }
    if (body.admin_naam) zetInstelling('admin_naam', tekst(body.admin_naam, 40));
    return json(res, 200, { ok: true, agent_token: instelling('agent_token') });
  }

  if (pad.startsWith('/api/')) return fout(res, 404, 'Onbekende route');
  if (methode === 'GET' || methode === 'HEAD') return statisch(req, res, pad === '/' ? '/index.html' : pad);
  return fout(res, 405, 'Methode niet toegestaan');
}

// De AI-agent krijgt precies genoeg om een ticket te onderzoeken: het ticket,
// de gesprekken, de laatste scan van dat IP en de sites die erop draaien.
async function agentRoutes(req, res, delen, url) {
  const methode = req.method;
  if (delen[2] === 'tickets' && !delen[3]) {
    if (methode === 'GET') {
      const status = url.searchParams.get('status');
      const lijst = status
        ? tickets.lijst('WHERE t.status=?', [status])
        : tickets.lijst("WHERE t.status IN ('open','in behandeling','wacht op Tom')");
      return json(res, 200, { tickets: lijst });
    }
    if (methode === 'POST') {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      let t;
      try { t = ticketVanBody(body); } catch (e) { return fout(res, 400, e.message); }
      const r = db.prepare(`INSERT INTO tickets(ip,titel,omschrijving,prioriteit,status,aangemaakt,bijgewerkt)
        VALUES(?,?,?,?,?,?,?)`).run(t.ip, t.titel, t.omschrijving, t.prioriteit, 'in behandeling', nu(), nu());
      return json(res, 201, { ticket: tickets.een(r.lastInsertRowid) });
    }
  }
  if (delen[2] === 'tickets' && delen[3]) {
    const ticket = tickets.een(delen[3]);
    if (!ticket) return fout(res, 404, 'Ticket niet gevonden');
    if (methode === 'GET' && !delen[4]) {
      return json(res, 200, { ticket, berichten: tickets.berichten(ticket.id), context: tickets.context(ticket) });
    }
    if (methode === 'POST' && delen[4] === 'berichten') {
      const body = await leesBody(req).catch(() => null);
      const bericht = tekst(body && body.bericht, 4000);
      if (!bericht) return fout(res, 400, 'Bericht is leeg');
      tickets.voegBerichtToe(ticket.id, 'AI-agent', 'agent', bericht);
      if (body.status && STATUSSEN.includes(body.status)) db.prepare('UPDATE tickets SET status=? WHERE id=?').run(body.status, ticket.id);
      if (body.ai_onderzoek !== undefined) db.prepare('UPDATE tickets SET ai_onderzoek=? WHERE id=?').run(tekst(body.ai_onderzoek, 8000), ticket.id);
      return json(res, 201, { ticket: tickets.een(ticket.id), berichten: tickets.berichten(ticket.id) });
    }
    if (methode === 'PATCH' && !delen[4]) {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      if (body.status && !STATUSSEN.includes(body.status)) return fout(res, 400, 'Onbekende status');
      if (body.status) db.prepare('UPDATE tickets SET status=?, bijgewerkt=? WHERE id=?').run(body.status, nu(), ticket.id);
      if (body.ai_onderzoek !== undefined) db.prepare('UPDATE tickets SET ai_onderzoek=? WHERE id=?').run(tekst(body.ai_onderzoek, 8000), ticket.id);
      return json(res, 200, { ticket: tickets.een(ticket.id) });
    }
  }
  if (delen[2] === 'scan' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    try {
      const uit = await scanHost(body && body.ip);
      db.prepare(`INSERT INTO hosts(ip,laatste_scan,poorten,diensten) VALUES(?,?,?,?) ON CONFLICT(ip) DO UPDATE SET
        laatste_scan=excluded.laatste_scan,poorten=excluded.poorten,diensten=excluded.diensten`)
        .run(uit.ip, uit.op, JSON.stringify(uit.poorten), JSON.stringify(uit.diensten));
      return json(res, 200, { scan: uit });
    } catch (e) { return fout(res, 400, e.message); }
  }
  if (delen[2] === 'sites' && methode === 'GET') {
    return json(res, 200, { sites: sites.lijst().map((s) => siteBeeld(s)) });
  }
  return fout(res, 404, 'Onbekende agent-route');
}

// ── start ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.req = req;
  verwerk(req, res).catch((e) => {
    console.error('Fout in verzoek ' + req.method + ' ' + req.url + ': ' + (e && e.stack || e));
    if (!res.headersSent) fout(res, 500, 'Interne fout');
  });
});

function seed() {
  const aantal = db.prepare('SELECT COUNT(*) n FROM sites').get().n;
  if (aantal > 0) return;
  const begin = [
    { naam: 'VoorraadThuis', url: 'https://thuis.werdensmedia.net/', ip: '', repo: 'voorraadthuis', stats_url: '' },
    { naam: 'BeatSync Studio', url: 'https://theberas04.github.io/beatsync-studio/', ip: '', repo: 'beatsync-studio', stats_url: '' },
  ];
  const zet = db.prepare('INSERT INTO sites(naam,url,ip,repo,stats_url,interval_s,actief,aangemaakt) VALUES(?,?,?,?,?,?,?,?)');
  for (const s of begin) zet.run(s.naam, s.url, s.ip, s.repo, s.stats_url, 120, 1, nu());
}

if (require.main === module) {
  seed();
  server.listen(POORT, () => console.log('Werdens Monitor luistert op poort ' + POORT));
  setTimeout(() => meetRonde().catch(() => {}), 1500);
  setTimeout(() => { if (instelling('agent_token')) verversProjecten(); }, 5000);
  setInterval(() => meetRonde().catch(() => {}), 30e3);
  setInterval(() => { if (!ververstBezig) verversProjecten(); }, 15 * 60e3);
  setInterval(() => db.prepare('DELETE FROM sessies WHERE verloopt < ?').run(nu()), 3600e3);
}

module.exports = { server, db, app: { overzicht, meetSite, siteBeeld, ticketVanBody, siteVanBody }, tickets, sites, projecten, sessies, wachtwoordAfpruk: wachtwoordAfdruk };