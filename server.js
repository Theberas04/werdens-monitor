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
const os = require('node:os');
const sqlite3 = require('node:sqlite');
const { URL } = require('node:url');
const { controleerSite, haalStats, scanHost } = require('./lib/checks');
const github = require('./lib/github');
const { haalProjecten } = github;
const update = require('./lib/update');
const slack = require('./lib/slack');
const hardware = require('./lib/hardware');
const netwerk = require('./lib/netwerk');
const libApparaten = require('./lib/apparaten');
const grafiek = require('./lib/grafiek');

// Laatste netwerkscan in het geheugen: het dashboard hoeft hem niet te bewaren,
// hij is toch maar een momentopname. `netwerkGevonden` onthoudt de namen zodat
// toevoegen de reverse-DNS-naam meteen kan meenemen.
let netwerkLaatst = null;
let netwerkGevonden = [];

const POORT = Number(process.env.PORT || 8080);
const BASIS = process.env.BASE_URL || ('http://localhost:' + POORT);
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
CREATE TABLE IF NOT EXISTS host_controles(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, op TEXT NOT NULL, ok INTEGER NOT NULL,
  poorten INTEGER NOT NULL DEFAULT 0, ping_ms INTEGER, tls_dagen INTEGER, fout TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_hostcontroles ON host_controles(ip, op DESC);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, soort TEXT NOT NULL, bericht TEXT NOT NULL,
  op TEXT NOT NULL, gezien INTEGER NOT NULL DEFAULT 0, opgelost TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(op DESC);
CREATE TABLE IF NOT EXISTS onderhoud(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, van TEXT NOT NULL, tot TEXT NOT NULL,
  reden TEXT NOT NULL DEFAULT '', aangemaakt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gebeurtenissen(
  id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, soort TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '', tekst TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slack_verzonden(
  ip TEXT NOT NULL DEFAULT '', soort TEXT NOT NULL, op TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
  fout TEXT NOT NULL DEFAULT '', PRIMARY KEY(ip, soort));
CREATE TABLE IF NOT EXISTS servers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, host TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL, lokaal INTEGER NOT NULL DEFAULT 0, actief INTEGER NOT NULL DEFAULT 1,
  laatste TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '', fout TEXT NOT NULL DEFAULT '',
  aangemaakt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS server_metingen(
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL, op TEXT NOT NULL,
  cpu_pct REAL, ram_pct REAL, disk_pct REAL, gpu_pct REAL, temp_c REAL, data TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_servermetingen ON server_metingen(server_id, op DESC);
CREATE TABLE IF NOT EXISTS apparaten(
  id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, soort TEXT NOT NULL DEFAULT 'generiek',
  url TEXT NOT NULL DEFAULT '', gebruiker TEXT NOT NULL DEFAULT '', geheim TEXT NOT NULL DEFAULT '',
  actief INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'onbekend',
  laatste TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '', fout TEXT NOT NULL DEFAULT '',
  aangemaakt TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS apparaat_metingen(
  id INTEGER PRIMARY KEY AUTOINCREMENT, apparaat_id INTEGER NOT NULL, op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'onbekend', data TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_apparaatmetingen ON apparaat_metingen(apparaat_id, op DESC);
`);

// Kolommen die later zijn bijgekomen, netjes toevoegen aan een bestaande database.
function kolomErbij(tabel, kolom, definitie) {
  const kolommen = db.prepare(`PRAGMA table_info(${tabel})`).all().map((c) => c.name);
  if (!kolommen.includes(kolom)) db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${definitie}`);
}
kolomErbij('hosts', 'hostnaam', "TEXT NOT NULL DEFAULT ''");
kolomErbij('hosts', 'actief', 'INTEGER NOT NULL DEFAULT 1');
kolomErbij('hosts', 'interval_s', 'INTEGER NOT NULL DEFAULT 300');
kolomErbij('hosts', 'ping_ms', 'INTEGER');
kolomErbij('hosts', 'tls_dagen', 'INTEGER');
kolomErbij('hosts', 'tls_verloopt', "TEXT NOT NULL DEFAULT ''");
kolomErbij('hosts', 'ok', 'INTEGER NOT NULL DEFAULT 1');
kolomErbij('hosts', 'fout', "TEXT NOT NULL DEFAULT ''");
kolomErbij('hosts', 'aangemaakt', "TEXT NOT NULL DEFAULT ''");
// Zabbix-achtige meldingsvelden: ernst, bevestigen (acknowledge) en escalatie.
kolomErbij('alerts', 'ernst', "TEXT NOT NULL DEFAULT ''");
kolomErbij('alerts', 'bevestigd', 'INTEGER NOT NULL DEFAULT 0');
kolomErbij('alerts', 'bevestigd_op', "TEXT NOT NULL DEFAULT ''");
kolomErbij('alerts', 'bevestigd_door', "TEXT NOT NULL DEFAULT ''");
kolomErbij('alerts', 'notitie', "TEXT NOT NULL DEFAULT ''");
kolomErbij('alerts', 'gemeld_op', "TEXT NOT NULL DEFAULT ''");
kolomErbij('alerts', 'meldingen', 'INTEGER NOT NULL DEFAULT 0');
// Oude meldingen hebben nog geen ernst of meldmoment; vul die één keer in zodat
// het problemenoverzicht en de escalatie meteen kloppen.
for (const [soort, ernst] of Object.entries({
  'host neer': 'kritiek', 'apparaat neer': 'kritiek', 'site neer': 'kritiek',
  'host online': 'info', 'apparaat online': 'info', 'site online': 'info',
  certificaat: 'gemiddeld', 'poort open': 'waarschuwing', 'poort dicht': 'waarschuwing',
})) {
  db.prepare("UPDATE alerts SET ernst=? WHERE soort=? AND (ernst='' OR ernst IS NULL)").run(ernst, soort);
}
db.prepare("UPDATE alerts SET gemeld_op=op WHERE gemeld_op='' OR gemeld_op IS NULL").run();

const nu = () => new Date().toISOString();
function instelling(sleutel, standaard = '') {
  const r = db.prepare('SELECT waarde FROM instellingen WHERE sleutel=?').get(sleutel);
  return r ? r.waarde : standaard;
}
function zetInstelling(sleutel, waarde) {
  db.prepare('INSERT INTO instellingen(sleutel,waarde) VALUES(?,?) ON CONFLICT(sleutel) DO UPDATE SET waarde=excluded.waarde')
    .run(sleutel, String(waarde));
}

// Het GitHub-token uit de database heeft voorrang op de omgeving: wat de
// gebruiker in het dashboard invult, hoort meteen te werken.
github.zetToken(instelling('github_token'));

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
  const vorige = sites.laatste(site.id);
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
  // Een website die omvalt is net zo goed een storing als een host: dezelfde
  // meldingen, ernst en escalatie. De sleutel begint met 'site:' zodat hij niet
  // met een IP-adres botst.
  const sleutel = 'site:' + site.id;
  if (vorige && vorige.ok && !meting.ok) {
    meld(sleutel, 'site neer', site.naam + ' is niet bereikbaar: ' + (meting.fout || 'HTTP ' + meting.code));
  }
  if (vorige && !vorige.ok && meting.ok) {
    meld(sleutel, 'site online', site.naam + ' is weer bereikbaar');
    losOp(sleutel, 'site neer');
  }
  if (meting.ok && meting.tls_dagen !== null && meting.tls_dagen !== undefined && meting.tls_dagen <= 14) {
    meld(sleutel, 'certificaat', 'Certificaat van ' + site.naam + ' verloopt over ' + meting.tls_dagen + ' dagen');
  }
  if (meting.ok && (meting.tls_dagen === null || meting.tls_dagen === undefined || meting.tls_dagen > 14)) {
    losOp(sleutel, 'certificaat');
  }
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

// ── hosts (IP-adressen) ──────────────────────────────────────────────────────
// Elk IP-adres is een host met een eigen interval, geschiedenis, status,
// storingen en onderhoudsvenster. De scan levert alles wat het dashboard nodig
// heeft: naam, open poorten, diensten met titel, pingtijd en het certificaat.
const parseJson = (waarde, standaard) => {
  try { const u = JSON.parse(waarde); return u === null || u === undefined ? standaard : u; } catch { return standaard; }
};

// ── meldingen (naar het voorbeeld van Zabbix) ────────────────────────────────
// Elke melding heeft een ernst (info → kritiek), kan bevestigd worden
// (acknowledge) en gaat één keer naar Slack. Een kritieke of hoge melding die
// niet bevestigd is, wordt na een uur opnieuw gemeld (escalatie). Tijdens een
// onderhoudsvenster — per host of voor alles ('*') — gaat er niets naar buiten.
const ERNST = {
  'host neer': 'kritiek', 'apparaat neer': 'kritiek', 'site neer': 'kritiek',
  'host online': 'info', 'apparaat online': 'info', 'site online': 'info',
  certificaat: 'gemiddeld', 'poort open': 'waarschuwing', 'poort dicht': 'waarschuwing',
  'site traag': 'waarschuwing', 'schijf vol': 'gemiddeld', 'geheugen vol': 'gemiddeld',
};
const ERNST_ORDE = { kritiek: 0, hoog: 1, gemiddeld: 2, waarschuwing: 3, info: 4 };
const ERNST_LABEL = { kritiek: 'Kritiek', hoog: 'Hoog', gemiddeld: 'Gemiddeld', waarschuwing: 'Waarschuwing', info: 'Info' };
const ernstVan = (soort, ernst) => {
  if (ernst && ERNST_ORDE[ernst] !== undefined) return ernst;
  return ERNST[String(soort || '')] || 'gemiddeld';
};

const SLACK_COOLDOWN_MS = 20 * 60 * 1000;
const ESCALATIE_MS = 60 * 60 * 1000;

// Onderhoud geldt voor één IP of voor alles (ip='*'), en alleen binnen van..tot.
function inOnderhoud(ip) {
  const op = nu();
  const rij = db.prepare("SELECT id FROM onderhoud WHERE (ip=? OR ip='*') AND tot>=? AND (van='' OR van<=?) LIMIT 1")
    .get(String(ip || ''), op, op);
  return !!rij;
}

function slackIngesteld() {
  return instelling('slack_aan') === '1' && !!instelling('slack_webhook');
}

function stuurSlack(alert) {
  if (!slackIngesteld()) return;
  // Bevestigd of in onderhoud: geen (herhaal)melding.
  if (alert.bevestigd) return;
  if (inOnderhoud(alert.ip)) return;
  const host = db.prepare('SELECT naam, hostnaam FROM hosts WHERE ip=?').get(alert.ip);
  const naam = (host && (host.naam || host.hostnaam)) || alert.naam || '';
  const soort = alert.soort === 'host online' || alert.soort === 'site online' ? 'herstel' : alert.soort;
  if (soort === 'herstel' && instelling('slack_herstel', '1') !== '1') return;
  const vorige = db.prepare('SELECT op, ok FROM slack_verzonden WHERE ip=? AND soort=?').get(alert.ip, soort);
  if (vorige && vorige.ok && soort !== 'herstel' && Date.now() - Date.parse(vorige.op) < SLACK_COOLDOWN_MS) return;
  const bewaar = (ok, fout) => db.prepare(`INSERT INTO slack_verzonden(ip,soort,op,ok,fout) VALUES(?,?,?,?,?)
    ON CONFLICT(ip,soort) DO UPDATE SET op=excluded.op, ok=excluded.ok, fout=excluded.fout`)
    .run(alert.ip, soort, nu(), ok ? 1 : 0, String(fout || '').slice(0, 300));
  bewaar(true, '');
  slack.meldAlert(instelling('slack_webhook'), { ...alert, soort, naam }, { basis: BASIS })
    .then((r) => {
      bewaar(r.ok, r.fout);
      if (r.ok) zetInstelling('slack_laatst', nu());
      else zetInstelling('slack_laatst_fout', nu() + ' — ' + r.fout);
    })
    .catch((e) => bewaar(false, e.message));
}

function meld(ip, soort, bericht, ernst) {
  const bestaat = db.prepare("SELECT id FROM alerts WHERE ip=? AND soort=? AND bericht=? AND opgelost=''").get(ip, soort, bericht);
  if (bestaat) return;
  const e = ernstVan(soort, ernst);
  const op = nu();
  const r = db.prepare('INSERT INTO alerts(ip,soort,bericht,op,ernst,gemeld_op,meldingen) VALUES(?,?,?,?,?,?,?)')
    .run(ip, soort, bericht, op, e, op, 1);
  db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)').run(op, 'alert', ip, bericht);
  const rij = db.prepare('SELECT * FROM alerts WHERE id=?').get(r.lastInsertRowid);
  if (rij) stuurSlack(rij);
}

function losOp(ip, soort) {
  const open = db.prepare("SELECT * FROM alerts WHERE ip=? AND soort=? AND opgelost=''").all(ip, soort);
  for (const a of open) {
    const op = nu();
    db.prepare('UPDATE alerts SET opgelost=? WHERE id=?').run(op, a.id);
    db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)').run(op, 'opgelost', ip, soort + ' opgelost');
    stuurSlack({ ...a, soort: 'herstel', bevestigd: 0, bericht: 'Opgelost: ' + a.bericht });
  }
}

// Escalatie: een open, onbevestigde kritieke/hoge melding wordt na een uur
// opnieuw gemeld. Zo blijft een echte storing niet ongemerkt liggen.
function escaleer() {
  const grens = new Date(Date.now() - ESCALATIE_MS).toISOString();
  const open = db.prepare(`SELECT * FROM alerts WHERE opgelost='' AND bevestigd=0
    AND ernst IN ('kritiek','hoog') AND (gemeld_op='' OR gemeld_op<=?)`).all(grens);
  for (const a of open) {
    if (inOnderhoud(a.ip)) continue;
    stuurSlack({ ...a, soort: 'escalatie', bericht: 'Nog niet opgelost (' + (ERNST_LABEL[a.ernst] || a.ernst) + '): ' + a.bericht });
    db.prepare('UPDATE alerts SET gemeld_op=?, meldingen=meldingen+1 WHERE id=?').run(nu(), a.id);
  }
}

const hosts = {
  lijst() { return db.prepare('SELECT * FROM hosts ORDER BY ip').all(); },
  een(ip) { return db.prepare('SELECT * FROM hosts WHERE ip=?').get(String(ip || '').trim()); },
  geschiedenis(ip, aantal = 40) {
    return db.prepare('SELECT * FROM host_controles WHERE ip=? ORDER BY id DESC LIMIT ?').all(ip, aantal).reverse();
  },
  uptime(ip, uren = 24) {
    const grens = new Date(Date.now() - uren * 3600e3).toISOString();
    const r = db.prepare('SELECT COUNT(*) n, SUM(ok) goed FROM host_controles WHERE ip=? AND op>=?').get(ip, grens);
    if (!r || !r.n) return null;
    return Math.round((r.goed || 0) / r.n * 1000) / 10;
  },
  onderhoud(ip) {
    return db.prepare('SELECT * FROM onderhoud WHERE ip=? AND tot>=? ORDER BY tot DESC').all(ip, nu());
  },
  alerts(ip, alleenOpen = true) {
    const waar = alleenOpen ? "AND opgelost=''" : '';
    return db.prepare('SELECT * FROM alerts WHERE ip=? ' + waar + ' ORDER BY id DESC').all(ip);
  },
  openAlerts() {
    return db.prepare(`SELECT a.*, h.naam hostnaam FROM alerts a LEFT JOIN hosts h ON h.ip=a.ip
      WHERE a.opgelost='' ORDER BY CASE a.soort WHEN 'host neer' THEN 0 ELSE 1 END, a.id DESC`).all();
  },
  sitesOp(ip) {
    return sites.lijst().filter((s) => {
      if (s.ip === ip) return true;
      try { return new URL(s.url).hostname === ip; } catch { return false; }
    }).map((s) => siteBeeld(s));
  },
  bewaarScan(uit) {
    const vorige = hosts.een(uit.ip);
    const oudePoorten = parseJson(vorige && vorige.poorten, []);
    const tls = uit.tls || {};
    const fout = uit.ok ? '' : 'Geen open poorten';
    db.prepare(`INSERT INTO hosts(ip,naam,hostnaam,laatste_scan,poorten,diensten,ping_ms,tls_dagen,tls_verloopt,ok,fout,aangemaakt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ip) DO UPDATE SET hostnaam=excluded.hostnaam, laatste_scan=excluded.laatste_scan,
        poorten=excluded.poorten, diensten=excluded.diensten, ping_ms=excluded.ping_ms,
        tls_dagen=excluded.tls_dagen, tls_verloopt=excluded.tls_verloopt, ok=excluded.ok, fout=excluded.fout`)
      .run(uit.ip, '', uit.hostnaam || '', uit.op, JSON.stringify(uit.poorten), JSON.stringify(uit.diensten),
        uit.ping_ms === null ? null : uit.ping_ms, tls.dagen === undefined ? null : tls.dagen,
        tls.verloopt || '', uit.ok ? 1 : 0, fout, nu());
    db.prepare('INSERT INTO host_controles(ip,op,ok,poorten,ping_ms,tls_dagen,fout) VALUES(?,?,?,?,?,?,?)')
      .run(uit.ip, uit.op, uit.ok ? 1 : 0, uit.poorten.length, uit.ping_ms === null ? null : uit.ping_ms,
        tls.dagen === undefined ? null : tls.dagen, fout);
    if (vorige && vorige.laatste_scan) {
      if (vorige.ok && !uit.ok) meld(uit.ip, 'host neer', 'Host is niet meer bereikbaar (geen open poorten)');
      if (!vorige.ok && uit.ok) { meld(uit.ip, 'host online', 'Host is weer bereikbaar'); losOp(uit.ip, 'host neer'); }
      const nieuw = uit.poorten.filter((p) => !oudePoorten.includes(p));
      const weg = oudePoorten.filter((p) => !uit.poorten.includes(p));
      if (nieuw.length) meld(uit.ip, 'poort open', 'Nieuwe open poort(en): ' + nieuw.join(', '));
      if (weg.length) meld(uit.ip, 'poort dicht', 'Poort(en) dicht: ' + weg.join(', '));
    }
    if (typeof tls.dagen === 'number' && tls.dagen < 14) {
      meld(uit.ip, 'certificaat', 'TLS-certificaat verloopt over ' + tls.dagen + ' dagen');
    }
    return { uit, vorige };
  },
  async scan(ip) {
    const uit = await scanHost(ip);
    return hosts.bewaarScan(uit);
  },
  status(host) {
    if (!host || !host.laatste_scan) return 'onbekend';
    if (hosts.onderhoud(host.ip).length) return 'onderhoud';
    return host.ok ? 'ok' : 'neer';
  },
  beeld(host, uitgebreid = false) {
    const laatsteScan = host.laatste_scan || '';
    const onderhoud = hosts.onderhoud(host.ip);
    const sitesOpHost = hosts.sitesOp(host.ip);
    const openTickets = tickets.lijst('WHERE t.ip=? AND t.status IN (\'open\',\'in behandeling\',\'wacht op Tom\')', [host.ip]);
    const uit = {
      ip: host.ip, naam: host.naam || '', hostnaam: host.hostnaam || '', notitie: host.notitie || '',
      actief: !!host.actief, interval_s: host.interval_s, laatste_scan: laatsteScan,
      ok: !!host.ok, fout: host.fout || '', ping_ms: host.ping_ms, tls_dagen: host.tls_dagen,
      tls_verloopt: host.tls_verloopt || '', poorten: parseJson(host.poorten, []),
      diensten: parseJson(host.diensten, []), status: hosts.status(host),
      onderhoud, uptime24: hosts.uptime(host.ip), sites: sitesOpHost,
      tickets_open: openTickets.length, alerts: hosts.alerts(host.ip),
    };
    if (uitgebreid) uit.geschiedenis = hosts.geschiedenis(host.ip);
    return uit;
  },
};

// ── servers (hardware) ───────────────────────────────────────────────────────
// Een server stuurt zijn eigen cijfers: de lokale server leest /proc, /sys en
// df rechtstreeks; een andere server draait het agent-script en post naar
// /api/agent/hardware met zijn eigen token. Zo hoeft er geen SSH-sleutel in de
// monitor te staan en werkt het ook door een firewall heen.
const servers = {
  lijst() { return db.prepare('SELECT * FROM servers ORDER BY lokaal DESC, naam').all(); },
  een(id) { return db.prepare('SELECT * FROM servers WHERE id=?').get(Number(id)); },
  opToken(token) {
    if (!token) return null;
    return db.prepare('SELECT * FROM servers WHERE token=?').get(String(token));
  },
  geschiedenis(id, aantal = 80) {
    return db.prepare('SELECT * FROM server_metingen WHERE server_id=? ORDER BY id DESC LIMIT ?').all(Number(id), aantal).reverse();
  },
  status(s) {
    if (!s) return 'onbekend';
    if (s.fout) return 'fout';
    if (!s.laatste) return 'onbekend';
    const minuten = (Date.now() - new Date(s.laatste).getTime()) / 60000;
    if (minuten > 10) return 'stil';
    return 'ok';
  },
  samenvatting(data) {
    const d = data || {};
    const schijven = Array.isArray(d.schijven) ? d.schijven : [];
    const gpus = Array.isArray(d.gpu) ? d.gpu : [];
    const temps = Array.isArray(d.temperatuur) ? d.temperatuur : [];
    const max = (lijst, veld) => {
      let m = null;
      for (const x of lijst) {
        const v = x[veld];
        if (typeof v === 'number' && (m === null || v > m)) m = v;
      }
      return m;
    };
    return {
      cpu_pct: d.cpu ? d.cpu.gebruik_pct : null,
      ram_pct: d.geheugen ? d.geheugen.gebruikt_pct : null,
      disk_pct: schijven.length ? max(schijven, 'gebruikt_pct') : null,
      gpu_pct: gpus.length ? max(gpus, 'gebruik_pct') : null,
      temp_c: temps.length ? max(temps, 'c') : (gpus.length ? max(gpus, 'temp_c') : null),
      kernen: d.cpu ? d.cpu.kernen : null,
      ram_totaal_mb: d.geheugen ? d.geheugen.totaal_mb : null,
      schijven: schijven.length,
      gpus: gpus.length,
    };
  },
  beeld(s, uitgebreid = false) {
    const data = parseJson(s.data, null);
    const sam = servers.samenvatting(data);
    const uit = {
      id: s.id, naam: s.naam, host: s.host || '', lokaal: !!s.lokaal, actief: !!s.actief,
      laatste: s.laatste || '', fout: s.fout || '', status: servers.status(s),
      data, ...sam,
    };
    if (uitgebreid) uit.geschiedenis = servers.geschiedenis(s.id);
    return uit;
  },
  bewaar(id, data, fout = '') {
    const s = servers.een(id);
    if (!s) throw new Error('Server bestaat niet');
    const op = (data && data.op) || nu();
    db.prepare('UPDATE servers SET laatste=?, data=?, fout=? WHERE id=?')
      .run(op, data ? JSON.stringify(data) : s.data, String(fout || ''), id);
    if (data) {
      const sam = servers.samenvatting(data);
      db.prepare(`INSERT INTO server_metingen(server_id,op,cpu_pct,ram_pct,disk_pct,gpu_pct,temp_c,data)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, op, sam.cpu_pct, sam.ram_pct, sam.disk_pct, sam.gpu_pct, sam.temp_c, JSON.stringify(sam));
      // Houd de historie compact: per server de laatste 2880 metingen (24 uur bij 30 s).
      db.prepare(`DELETE FROM server_metingen WHERE server_id=? AND id NOT IN
        (SELECT id FROM server_metingen WHERE server_id=? ORDER BY id DESC LIMIT 2880)`).run(id, id);
    }
  },
  async meetLokaal(id) {
    const s = servers.een(id);
    if (!s) return null;
    try {
      const data = await hardware.verzamel();
      servers.bewaar(id, data, '');
      return servers.beeld(servers.een(id), true);
    } catch (e) {
      servers.bewaar(id, null, e.message);
      return servers.beeld(servers.een(id), true);
    }
  },
};

// ── apparaten (UniFi, TrueNAS, generiek HTTP) ────────────────────────────────
// Geen agent op het kastje zelf: de monitor praat met de API van het apparaat.
// Zelfde vorm als servers — status, laatste meting, data als JSON — zodat de
// UI en de geschiedenis hetzelfde werken.
const apparaten = {
  lijst() { return db.prepare('SELECT * FROM apparaten ORDER BY naam').all(); },
  een(id) { return db.prepare('SELECT * FROM apparaten WHERE id=?').get(Number(id)); },
  geschiedenis(id, aantal = 60) {
    return db.prepare('SELECT * FROM apparaat_metingen WHERE apparaat_id=? ORDER BY id DESC LIMIT ?')
      .all(Number(id), aantal).reverse();
  },
  // Alerts hebben een ip-kolom; voor een apparaat gebruiken we een eigen sleutel
  // zodat host- en apparaatmeldingen elkaar niet in de weg zitten.
  sleutel(a) { return 'apparaat:' + (a.naam || a.id); },
  status(a) {
    if (!a) return 'onbekend';
    if (a.fout) return 'fout';
    if (!a.laatste) return 'onbekend';
    const minuten = (Date.now() - new Date(a.laatste).getTime()) / 60000;
    if (minuten > 15) return 'stil';
    return 'ok';
  },
  beeld(a, uitgebreid = false) {
    const uit = {
      id: a.id, naam: a.naam, soort: a.soort, url: a.url, gebruiker: a.gebruiker || '',
      heeft_geheim: !!a.geheim, actief: !!a.actief, status: apparaten.status(a),
      laatste: a.laatste || '', fout: a.fout || '', data: parseJson(a.data, null),
      aangemaakt: a.aangemaakt || '',
    };
    if (uitgebreid) uit.geschiedenis = apparaten.geschiedenis(a.id);
    return uit;
  },
  bewaar(id, status, data, fout = '') {
    const a = apparaten.een(id);
    if (!a) throw new Error('Apparaat bestaat niet');
    const op = nu();
    db.prepare('UPDATE apparaten SET laatste=?, status=?, data=?, fout=? WHERE id=?')
      .run(op, String(status || 'onbekend'), data ? JSON.stringify(data) : a.data, String(fout || ''), id);
    db.prepare('INSERT INTO apparaat_metingen(apparaat_id,op,status,data) VALUES(?,?,?,?)')
      .run(id, op, String(status || 'onbekend'), JSON.stringify(data || {}));
    db.prepare(`DELETE FROM apparaat_metingen WHERE apparaat_id=? AND id NOT IN
      (SELECT id FROM apparaat_metingen WHERE apparaat_id=? ORDER BY id DESC LIMIT 2880)`).run(id, id);
  },
  async meet(id) {
    const a = apparaten.een(id);
    if (!a) return null;
    const uit = await libApparaten.meten(a);
    const was = a.fout ? 'fout' : (a.laatste ? 'ok' : 'onbekend');
    apparaten.bewaar(id, uit.status, uit.data, uit.fout);
    const sleutel = apparaten.sleutel(a);
    if (uit.status === 'fout' && was === 'ok') {
      meld(sleutel, 'apparaat neer', a.naam + ' is niet bereikbaar: ' + (uit.fout || 'onbekende fout'));
    }
    if (uit.status === 'ok' && was === 'fout') {
      meld(sleutel, 'apparaat online', a.naam + ' is weer bereikbaar');
      losOp(sleutel, 'apparaat neer');
    }
    return apparaten.beeld(apparaten.een(id), true);
  },
  async ronde() {
    for (const a of apparaten.lijst()) {
      if (a.actief) await apparaten.meet(a.id).catch(() => {});
    }
  },
};

// De eigen server bestaat altijd: anders zou het dashboard zichzelf niet zien.
function zorgLokaleServer() {
  const bestaand = db.prepare('SELECT id FROM servers WHERE lokaal=1').get();
  if (bestaand) return bestaand.id;
  const naam = tekst(process.env.SERVER_NAAM, 80) || os.hostname();
  const r = db.prepare('INSERT INTO servers(naam,host,token,lokaal,actief,aangemaakt) VALUES(?,?,?,?,?,?)')
    .run(naam, os.hostname(), crypto.randomBytes(24).toString('hex'), 1, 1, nu());
  return r.lastInsertRowid;
}

async function serverRonde() {
  for (const s of servers.lijst()) {
    if (s.lokaal && s.actief) await servers.meetLokaal(s.id);
  }
}

function hostVanBody(body, bestaand = null) {
  const ip = tekst(body.ip, 60);
  if (!ip) throw new Error('IP-adres is verplicht');
  if (!geldigIp(ip)) throw new Error('Geen geldig IP-adres');
  if (!bestaand && hosts.een(ip)) throw new Error('Dit IP-adres staat er al');
  const interval = Math.min(86400, Math.max(60, Number(body.interval_s) || (bestaand && bestaand.interval_s) || 300));
  return {
    ip,
    naam: tekst(body.naam, 80) || (bestaand && bestaand.naam) || '',
    notitie: tekst(body.notitie, 300) || (bestaand && bestaand.notitie) || '',
    interval_s: interval,
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
    const hostRij = ticket.ip ? hosts.een(ticket.ip) : null;
    const passendeSites = sites.lijst().filter((s) => s.ip === ticket.ip || (s.url || '').includes(ticket.ip)).map((s) => {
      const l = sites.laatste(s.id);
      return { naam: s.naam, url: s.url, ok: l ? !!l.ok : null, code: l && l.code, ms: l && l.ms, versie: l && l.versie, op: l && l.op };
    });
    return {
      ip: ticket.ip, host: hostRij ? hosts.beeld(hostRij) : null,
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

let hostBezig = false;
async function hostRonde() {
  if (hostBezig) return;
  hostBezig = true;
  try {
    for (const h of hosts.lijst()) {
      if (!h.actief) continue;
      if (inOnderhoud(h.ip)) continue;                 // in onderhoud: niet scannen
      const volgende = h.laatste_scan ? new Date(h.laatste_scan).getTime() + (h.interval_s || 300) * 1000 : 0;
      if (Date.now() < volgende) continue;
      try { await hosts.scan(h.ip); } catch (e) { console.error('Scan mislukt voor ' + h.ip + ': ' + e.message); }
    }
    db.prepare('DELETE FROM host_controles WHERE op < ?').run(new Date(Date.now() - 30 * 86400e3).toISOString());
  } finally { hostBezig = false; }
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
  const hostRijen = hosts.lijst();
  const hostBeelden = hostRijen.map((h) => hosts.beeld(h));
  const alertsOpen = hosts.openAlerts();
  const serverBeelden = servers.lijst().map((x) => servers.beeld(x));
  const weekGrens = Date.now() - 7 * 86400e3;
  return {
    servers: serverBeelden,
    samenvatting: {
      servers: serverBeelden.length,
      servers_ok: serverBeelden.filter((s) => s.status === 'ok').length,
      servers_vol: serverBeelden.filter((s) => (s.disk_pct || 0) >= 90 || (s.cpu_pct || 0) >= 90 || (s.ram_pct || 0) >= 90).length,
      sites: siteLijst.length, sites_ok: siteLijst.length - neer.length, sites_neer: neer.length,
      hosts: hostRijen.length,
      hosts_ok: hostBeelden.filter((h) => h.status === 'ok').length,
      hosts_neer: hostBeelden.filter((h) => h.status === 'neer').length,
      alerts_open: alertsOpen.length,
      projecten: projectenLijst.length,
      projecten_actief: projectenLijst.filter((p) => p.commit_datum && new Date(p.commit_datum).getTime() > weekGrens).length,
      projecten_ci_fout: projectenLijst.filter((p) => p.ci_status === 'failure').length,
      tickets_open: open.length, tickets_kritiek: open.filter((t) => t.prioriteit === 'kritiek').length,
      laatste_meting: siteLijst.reduce((a, s) => (s.laatste && s.laatste.op > a ? s.laatste.op : a), ''),
      projecten_op: instelling('projecten_op'), projecten_fout: instelling('projecten_fout'),
    },
    sites: siteLijst, tickets: open.slice(0, 6), projecten: projectenLijst.slice(0, 6),
    hosts: hostBeelden, alerts: alertsOpen.slice(0, 8),
    gebeurtenissen: db.prepare('SELECT * FROM gebeurtenissen ORDER BY id DESC LIMIT 6').all(),
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

  // Hardware-agent: elke server heeft zijn eigen token, geen beheerderssessie.
  if (pad === '/api/agent/hardware' && methode === 'POST') {
    const token = String(req.headers['x-agent-token'] || '').trim();
    const server = servers.opToken(token);
    if (!server) return fout(res, 401, 'Onbekend of ongeldig server-token');
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    if (!data || !data.cpu || !data.geheugen) return fout(res, 400, 'Geen bruikbare meetgegevens');
    servers.bewaar(server.id, data, '');
    return json(res, 200, { ok: true, server: servers.beeld(servers.een(server.id)) });
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
      // de pagina zelf is de inlogpagina; de app verbergt alles tot je inlogt.
      // Merk- en PWA-bestanden zijn openbaar: het logo op de inlogpagina moet
      // laden zonder sessie, anders blijft het een kapot beeld.
      if (pad === '/' || pad === '/index.html') return statisch(req, res, '/index.html');
      if (/^\/(assets\/|icon-\d+\.png$|apple-touch-icon\.png$|favicon\.svg$|manifest\.webmanifest$)/.test(pad)) {
        return statisch(req, res, pad);
      }
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

  // ── IP-adressen ────────────────────────────────────────────────────────────
  if (pad === '/api/hosts' && methode === 'GET') {
    const rijen = hosts.lijst();
    return json(res, 200, {
      hosts: rijen.map((h) => hosts.beeld(h)),
      alerts: hosts.openAlerts(),
    });
  }
  if (pad === '/api/hosts' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    let host;
    try { host = hostVanBody(body); } catch (e) { return fout(res, 400, e.message); }
    db.prepare(`INSERT INTO hosts(ip,naam,notitie,interval_s,actief,aangemaakt) VALUES(?,?,?,?,?,?)`)
      .run(host.ip, host.naam, host.notitie, host.interval_s, host.actief, nu());
    db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
      .run(nu(), 'host toegevoegd', host.ip, 'Host ' + host.ip + ' toegevoegd');
    // Meteen scannen: het dashboard hoort na het toevoegen al gevuld te zijn.
    try { await hosts.scan(host.ip); } catch (e) { console.error('Eerste scan mislukt voor ' + host.ip + ': ' + e.message); }
    return json(res, 201, { host: hosts.beeld(hosts.een(host.ip), true) });
  }
  if (delen[1] === 'hosts' && delen[2] && delen[2] !== 'scan') {
    const ip = decodeURIComponent(delen[2]);
    const host = hosts.een(ip);
    if (!host) return fout(res, 404, 'Dit IP-adres staat niet in de lijst');
    if (methode === 'GET' && !delen[3]) {
      return json(res, 200, {
        host: hosts.beeld(host, true),
        tickets: tickets.lijst('WHERE t.ip=?', [ip]),
        gebeurtenissen: db.prepare('SELECT * FROM gebeurtenissen WHERE ip=? ORDER BY id DESC LIMIT 40').all(ip),
        onderhoud: db.prepare('SELECT * FROM onderhoud WHERE ip=? ORDER BY tot DESC').all(ip),
      });
    }
    if (methode === 'PATCH' && !delen[3]) {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      let nieuw;
      try { nieuw = hostVanBody({ ...body, ip }, host); } catch (e) { return fout(res, 400, e.message); }
      db.prepare('UPDATE hosts SET naam=?, notitie=?, interval_s=?, actief=? WHERE ip=?')
        .run(nieuw.naam, nieuw.notitie, nieuw.interval_s, nieuw.actief, ip);
      return json(res, 200, { host: hosts.beeld(hosts.een(ip), true) });
    }
    if (methode === 'DELETE' && !delen[3]) {
      for (const tabel of ['host_controles', 'alerts', 'onderhoud', 'hosts']) {
        db.prepare(`DELETE FROM ${tabel} WHERE ip=?`).run(ip);
      }
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'host verwijderd', ip, 'Host ' + ip + ' verwijderd');
      return json(res, 200, { ok: true });
    }
    if (methode === 'POST' && delen[3] === 'scan') {
      try {
        const { uit } = await hosts.scan(ip);
        return json(res, 200, { scan: uit, host: hosts.beeld(hosts.een(ip), true) });
      } catch (e) { return fout(res, 400, e.message); }
    }
    if (methode === 'POST' && delen[3] === 'onderhoud') {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      const van = tekst(body.van, 40) || nu();
      const tot = tekst(body.tot, 40);
      if (!tot) return fout(res, 400, 'Eindtijd is verplicht');
      if (new Date(tot).getTime() <= Date.now()) return fout(res, 400, 'Eindtijd moet in de toekomst liggen');
      db.prepare('INSERT INTO onderhoud(ip,van,tot,reden,aangemaakt) VALUES(?,?,?,?,?)')
        .run(ip, van, tot, tekst(body.reden, 200), nu());
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'onderhoud', ip, 'Onderhoud tot ' + tot);
      return json(res, 201, { onderhoud: db.prepare('SELECT * FROM onderhoud WHERE ip=? ORDER BY tot DESC').all(ip) });
    }
    if (methode === 'DELETE' && delen[3] === 'onderhoud' && delen[4]) {
      db.prepare('DELETE FROM onderhoud WHERE id=? AND ip=?').run(Number(delen[4]), ip);
      return json(res, 200, { ok: true });
    }
  }
  // ── servers (hardware) ─────────────────────────────────────────────────────
  if (pad === '/api/servers' && methode === 'GET') {
    return json(res, 200, { servers: servers.lijst().map((s) => servers.beeld(s)) });
  }
  if (pad === '/api/servers' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    const naam = tekst(body.naam, 80);
    if (!naam) return fout(res, 400, 'Naam is verplicht');
    const host = tekst(body.host, 120);
    const lokaal = body.lokaal ? 1 : 0;
    const token = crypto.randomBytes(24).toString('hex');
    const r = db.prepare('INSERT INTO servers(naam,host,token,lokaal,actief,aangemaakt) VALUES(?,?,?,?,?,?)')
      .run(naam, host, token, lokaal, 1, nu());
    db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
      .run(nu(), 'server toegevoegd', host, 'Server ' + naam + ' toegevoegd');
    if (lokaal) await servers.meetLokaal(r.lastInsertRowid);
    return json(res, 201, { server: servers.beeld(servers.een(r.lastInsertRowid), true), token });
  }
  if (delen[1] === 'servers' && delen[2]) {
    const server = servers.een(delen[2]);
    if (!server) return fout(res, 404, 'Deze server staat niet in de lijst');
    if (methode === 'GET' && !delen[3]) {
      return json(res, 200, {
        server: servers.beeld(server, true),
        metingen: servers.geschiedenis(server.id, 120),
        sites: db.prepare('SELECT naam, url FROM sites WHERE ip=?').all(server.host || ''),
      });
    }
    if (methode === 'PATCH' && !delen[3]) {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      db.prepare('UPDATE servers SET naam=?, host=?, actief=? WHERE id=?')
        .run(tekst(body.naam, 80) || server.naam, tekst(body.host, 120) || server.host,
          body.actief === undefined ? server.actief : (body.actief ? 1 : 0), server.id);
      return json(res, 200, { server: servers.beeld(servers.een(server.id), true) });
    }
    if (methode === 'DELETE' && !delen[3]) {
      if (server.lokaal) return fout(res, 400, 'De eigen server kan niet verwijderd worden');
      db.prepare('DELETE FROM server_metingen WHERE server_id=?').run(server.id);
      db.prepare('DELETE FROM servers WHERE id=?').run(server.id);
      return json(res, 200, { ok: true });
    }
    if (methode === 'POST' && delen[3] === 'token') {
      const nieuw = crypto.randomBytes(24).toString('hex');
      db.prepare('UPDATE servers SET token=? WHERE id=?').run(nieuw, server.id);
      return json(res, 200, { ok: true, token: nieuw });
    }
    if (methode === 'POST' && delen[3] === 'verversen') {
      if (!server.lokaal) return fout(res, 400, 'Een externe server wordt door zijn eigen agent gemeten');
      const uit = await servers.meetLokaal(server.id);
      return json(res, 200, { server: uit });
    }
  }

  // ── apparaten (homelab: UniFi, TrueNAS, generiek) ───────────────────────────
  if (pad === '/api/apparaten' && methode === 'GET') {
    return json(res, 200, { apparaten: apparaten.lijst().map((a) => apparaten.beeld(a)), soorten: libApparaten.SOORTEN });
  }
  if (pad === '/api/apparaten' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    try {
      const naam = tekst(body.naam, 80);
      const soort = tekst(body.soort, 20).toLowerCase();
      const url = tekst(body.url, 300);
      if (!naam) return fout(res, 400, 'Naam is verplicht');
      if (!libApparaten.SOORTEN[soort]) return fout(res, 400, 'Onbekend soort apparaat');
      if (!/^https?:\/\//i.test(url)) return fout(res, 400, 'URL moet met http:// of https:// beginnen');
      const r = db.prepare('INSERT INTO apparaten(naam,soort,url,gebruiker,geheim,actief,aangemaakt) VALUES(?,?,?,?,?,?,?)')
        .run(naam, soort, url, tekst(body.gebruiker, 120), tekst(body.geheim, 300), body.actief === false ? 0 : 1, nu());
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'apparaat toegevoegd', '', 'Apparaat ' + naam + ' (' + soort + ') toegevoegd');
      const nieuw = apparaten.een(r.lastInsertRowid);
      // Meteen één meting, zodat je niet op de volgende ronde hoeft te wachten.
      const uit = await apparaten.meet(nieuw.id).catch(() => null);
      return json(res, 201, { apparaat: uit || apparaten.beeld(nieuw) });
    } catch (e) { return fout(res, 400, e.message); }
  }
  if (delen[1] === 'apparaten' && delen[2]) {
    const apparaat = apparaten.een(delen[2]);
    if (!apparaat) return fout(res, 404, 'Dit apparaat staat niet in de lijst');
    if (methode === 'GET' && !delen[3]) {
      return json(res, 200, { apparaat: apparaten.beeld(apparaat, true) });
    }
    if (methode === 'PATCH' && !delen[3]) {
      const body = await leesBody(req).catch(() => null);
      if (!body) return fout(res, 400, 'Ongeldige JSON');
      const soort = body.soort === undefined ? apparaat.soort : tekst(body.soort, 20).toLowerCase();
      if (!libApparaten.SOORTEN[soort]) return fout(res, 400, 'Onbekend soort apparaat');
      const url = body.url === undefined ? apparaat.url : tekst(body.url, 300);
      if (!/^https?:\/\//i.test(url)) return fout(res, 400, 'URL moet met http:// of https:// beginnen');
      // Een leeg geheim betekent: het bestaande wachtwoord/key laten staan.
      const geheim = body.geheim === undefined || body.geheim === '' ? apparaat.geheim : tekst(body.geheim, 300);
      db.prepare('UPDATE apparaten SET naam=?, soort=?, url=?, gebruiker=?, geheim=?, actief=? WHERE id=?')
        .run(tekst(body.naam, 80) || apparaat.naam, soort, url,
          body.gebruiker === undefined ? apparaat.gebruiker : tekst(body.gebruiker, 120), geheim,
          body.actief === undefined ? apparaat.actief : (body.actief ? 1 : 0), apparaat.id);
      return json(res, 200, { apparaat: apparaten.beeld(apparaten.een(apparaat.id)) });
    }
    if (methode === 'DELETE' && !delen[3]) {
      db.prepare('DELETE FROM apparaat_metingen WHERE apparaat_id=?').run(apparaat.id);
      db.prepare('DELETE FROM apparaten WHERE id=?').run(apparaat.id);
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'apparaat verwijderd', '', 'Apparaat ' + apparaat.naam + ' verwijderd');
      return json(res, 200, { ok: true });
    }
    if (methode === 'POST' && delen[3] === 'verversen') {
      const uit = await apparaten.meet(apparaat.id);
      return json(res, 200, { apparaat: uit });
    }
  }

  if (pad === '/api/alerts' && methode === 'GET') {
    return json(res, 200, { alerts: hosts.openAlerts(), alle: db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 100').all() });
  }
  if (delen[1] === 'alerts' && delen[2] && methode === 'POST') {
    const id = Number(delen[2]);
    const alert = db.prepare('SELECT * FROM alerts WHERE id=?').get(id);
    if (!alert) return fout(res, 404, 'Storing niet gevonden');
    if (delen[3] === 'gezien') db.prepare('UPDATE alerts SET gezien=1 WHERE id=?').run(id);
    else if (delen[3] === 'opgelost') db.prepare('UPDATE alerts SET opgelost=? WHERE id=?').run(nu(), id);
    else return fout(res, 404, 'Onbekende actie');
    return json(res, 200, { alert: db.prepare('SELECT * FROM alerts WHERE id=?').get(id) });
  }
  // ── grafieken (Grafana-achtig: tijdreeksen + annotaties) ───────────────────
  if (pad === '/api/grafiek' && methode === 'GET') {
    const gevraagd = new URL(req.url, 'http://localhost').searchParams.get('bereik') || '24u';
    const bereik = grafiek.UREN[gevraagd] ? gevraagd : '24u';
    return json(res, 200, { bereik, ...grafiek.alles(db, grafiek.UREN[bereik]) });
  }

  // ── problemen (Zabbix-achtig overzicht) ────────────────────────────────────
  if (pad === '/api/problemen' && methode === 'GET') {
    const open = hosts.openAlerts().map((a) => {
      const host = a.ip && a.ip.startsWith('site:') ? null : db.prepare('SELECT naam, hostnaam FROM hosts WHERE ip=?').get(a.ip);
      const naam = host ? (host.naam || host.hostnaam || a.ip) : (a.ip || '').replace(/^site:/, 'site ');
      return {
        ...a,
        ernst: a.ernst || ernstVan(a.soort),
        naam,
        in_onderhoud: inOnderhoud(a.ip),
        uptime24: host ? hosts.uptime(a.ip, 24) : null,
        uptime168: host ? hosts.uptime(a.ip, 168) : null,
      };
    }).sort((a, b) => (ERNST_ORDE[a.ernst] ?? 9) - (ERNST_ORDE[b.ernst] ?? 9) || String(b.op).localeCompare(String(a.op)));
    const tellingen = {};
    for (const k of Object.keys(ERNST_ORDE)) tellingen[k] = open.filter((a) => a.ernst === k).length;
    return json(res, 200, { problemen: open, tellingen, ernst: ERNST_LABEL, orde: ERNST_ORDE, onderhoud: inOnderhoud('*') });
  }
  if (delen[1] === 'problemen' && delen[2] && methode === 'POST') {
    const id = Number(delen[2]);
    const alert = db.prepare('SELECT * FROM alerts WHERE id=?').get(id);
    if (!alert) return fout(res, 404, 'Melding niet gevonden');
    const body = await leesBody(req).catch(() => ({}));
    if (delen[3] === 'bevestigen') {
      db.prepare("UPDATE alerts SET bevestigd=1, bevestigd_op=?, bevestigd_door=?, notitie=? WHERE id=?")
        .run(nu(), tekst(body.door, 80) || 'Tom', tekst(body.notitie, 500), id);
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'bevestigd', alert.ip, 'Melding bevestigd: ' + alert.bericht);
      return json(res, 200, { alert: db.prepare('SELECT * FROM alerts WHERE id=?').get(id) });
    }
    if (delen[3] === 'oplossen') {
      db.prepare('UPDATE alerts SET opgelost=?, notitie=? WHERE id=?')
        .run(nu(), tekst(body.notitie, 500) || alert.notitie || '', id);
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'opgelost', alert.ip, 'Melding opgelost: ' + alert.bericht);
      return json(res, 200, { alert: db.prepare('SELECT * FROM alerts WHERE id=?').get(id) });
    }
    if (delen[3] === 'terugzetten') {
      db.prepare("UPDATE alerts SET bevestigd=0, bevestigd_op='', bevestigd_door='' WHERE id=?").run(id);
      return json(res, 200, { alert: db.prepare('SELECT * FROM alerts WHERE id=?').get(id) });
    }
    return fout(res, 404, 'Onbekende actie');
  }

  // ── SLA: uptime per host over 24 uur en 7 dagen ─────────────────────────────
  if (pad === '/api/sla' && methode === 'GET') {
    const rijen = hosts.lijst().map((h) => ({
      ip: h.ip, naam: h.naam || h.hostnaam || h.ip, actief: !!h.actief,
      uptime24: hosts.uptime(h.ip, 24), uptime168: hosts.uptime(h.ip, 168),
      open: db.prepare("SELECT COUNT(*) n FROM alerts WHERE ip=? AND opgelost=''").get(h.ip).n,
    }));
    return json(res, 200, { hosts: rijen });
  }

  // ── onderhoudsvensters (per host of voor alles) ────────────────────────────
  if (pad === '/api/onderhoud' && methode === 'GET') {
    const alles = db.prepare('SELECT * FROM onderhoud ORDER BY tot DESC LIMIT 60').all();
    return json(res, 200, { onderhoud: alles, actief: alles.filter((o) => o.tot >= nu() && (!o.van || o.van <= nu())) });
  }
  if (pad === '/api/onderhoud' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    const ip = tekst(body.ip, 120) || '*';
    const van = tekst(body.van, 40) || nu();
    const tot = tekst(body.tot, 40);
    if (!tot) return fout(res, 400, 'Eindtijd is verplicht');
    if (Date.parse(tot) <= Date.parse(van)) return fout(res, 400, 'Eindtijd moet na de begintijd liggen');
    const reden = tekst(body.reden, 200) || 'Onderhoud';
    db.prepare('INSERT INTO onderhoud(ip,van,tot,reden,aangemaakt) VALUES(?,?,?,?,?)').run(ip, van, tot, reden, nu());
    db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
      .run(nu(), 'onderhoud', ip, 'Onderhoud tot ' + tot + (reden ? ': ' + reden : ''));
    return json(res, 201, { onderhoud: db.prepare('SELECT * FROM onderhoud ORDER BY tot DESC LIMIT 60').all() });
  }
  if (delen[1] === 'onderhoud' && delen[2] && methode === 'DELETE') {
    db.prepare('DELETE FROM onderhoud WHERE id=?').run(Number(delen[2]));
    return json(res, 200, { ok: true });
  }

  if (pad === '/api/gebeurtenissen' && methode === 'GET') {
    return json(res, 200, { gebeurtenissen: db.prepare('SELECT * FROM gebeurtenissen ORDER BY id DESC LIMIT 80').all() });
  }

  if (pad === '/api/hosts/scan' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    try {
      const ip = tekst(body.ip, 60);
      if (!geldigIp(ip)) return fout(res, 400, 'Geen geldig IP-adres');
      // Nog niet in de lijst? Dan meteen toevoegen en scannen.
      if (!hosts.een(ip)) {
        db.prepare('INSERT INTO hosts(ip,naam,notitie,interval_s,actief,aangemaakt) VALUES(?,?,?,?,?,?)')
          .run(ip, tekst(body.naam, 80), tekst(body.notitie, 300), 300, 1, nu());
      }
      const { uit } = await hosts.scan(ip);
      return json(res, 200, { scan: uit, host: hosts.beeld(hosts.een(ip), true) });
    } catch (e) { return fout(res, 400, e.message); }
  }

  // ── netwerk: alle adressen op het LAN van deze machine ─────────────────────
  if (pad === '/api/netwerk' && methode === 'GET') {
    return json(res, 200, { subnetten: netwerk.subnetten(), laatst: netwerkLaatst });
  }
  if (pad === '/api/netwerk/scan' && methode === 'POST') {
    const body = (await leesBody(req).catch(() => null)) || {};
    const lijst = netwerk.subnetten();
    if (!lijst.length) return fout(res, 400, 'Deze machine heeft geen LAN-interface met een IPv4-adres');
    const gekozen = body.cidr ? lijst.find((s) => s.cidr === String(body.cidr)) : lijst[0];
    if (!gekozen) return fout(res, 400, 'Onbekend subnet: ' + String(body.cidr));
    try {
      const gevonden = await netwerk.ontdek(gekozen);
      const bekend = new Set(hosts.lijst().map((h) => h.ip));
      netwerkLaatst = { op: nu(), cidr: gekozen.cidr, aantal: gevonden.length };
      netwerkGevonden = gevonden;
      return json(res, 200, {
        subnet: { cidr: gekozen.cidr, netwerk: gekozen.netwerk, prefix: gekozen.prefix, interface: gekozen.interface },
        subnetten: lijst,
        gevonden: gevonden.map((g) => ({
          ...g,
          bestaat_al: bekend.has(g.ip),
          naam: ((hosts.een(g.ip) || {}).naam) || '',
        })),
        laatst: netwerkLaatst,
      });
    } catch (e) { return fout(res, 400, 'Netwerkscan mislukt: ' + e.message); }
  }
  if (pad === '/api/netwerk/toevoegen' && methode === 'POST') {
    const body = await leesBody(req).catch(() => null);
    if (!body) return fout(res, 400, 'Ongeldige JSON');
    const ips = Array.isArray(body.ips) ? body.ips.map((x) => String(x || '').trim()) : [];
    const schoon = [...new Set(ips.filter((ip) => net.isIP(ip) === 4))];
    if (!schoon.length) return fout(res, 400, 'Geen geldige IPv4-adressen opgegeven');
    const interval = Math.min(86400, Math.max(60, Number(body.interval_s) || 300));
    const toegevoegd = [];
    const overgeslagen = [];
    for (const ip of schoon) {
      if (hosts.een(ip)) { overgeslagen.push(ip); continue; }
      const g = (netwerkGevonden || []).find((x) => x.ip === ip);
      db.prepare('INSERT INTO hosts(ip,naam,notitie,interval_s,actief,aangemaakt) VALUES(?,?,?,?,?,?)')
        .run(ip, tekst((g && g.hostnaam) || body.naam, 80), tekst(body.notitie, 300), interval, 1, nu());
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'host toegevoegd', ip, 'Host ' + ip + ' uit netwerkscan toegevoegd');
      toegevoegd.push(ip);
    }
    // Niet wachten op de volledige scan per host: de lijst vult zich, hostRonde
    // haalt daarna poorten, titels en certificaten op.
    if (toegevoegd.length) setTimeout(() => hostRonde().catch(() => {}), 50);
    return json(res, 200, { toegevoegd, overgeslagen, aantal: toegevoegd.length });
  }

  if (pad === '/api/instellingen' && methode === 'GET') {
    return json(res, 200, {
      admin_naam: instelling('admin_naam', 'tom'),
      agent_token: instelling('agent_token'),
      projecten_op: instelling('projecten_op'),
      projecten_fout: instelling('projecten_fout'),
      github_token: github.token() ? 'ingesteld' : 'niet ingesteld',
      github_token_bron: github.tokenBron(),
      github_login: instelling('github_login'),
      github_scopes: instelling('github_scopes'),
      update_versie: update.lokaal().versie,
      update_sha: update.lokaal().sha,
      slack_webhook: instelling('slack_webhook'),
      slack_aan: instelling('slack_aan') === '1',
      slack_herstel: instelling('slack_herstel', '1') === '1',
      slack_laatst: instelling('slack_laatst'),
      slack_laatst_fout: instelling('slack_laatst_fout'),
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
    if (body.slack_webhook !== undefined) {
      const invoer = tekst(body.slack_webhook, 400);
      if (invoer) {
        try { zetInstelling('slack_webhook', slack.controleerWebhook(invoer)); }
        catch (e) { return fout(res, 400, e.message); }
        zetInstelling('slack_laatst_fout', '');
      } else {
        zetInstelling('slack_webhook', '');
      }
    }
    if (body.github_token !== undefined) {
      const invoer = tekst(body.github_token, 200);
      if (invoer) {
        try {
          const wie = await github.wieIsToken(invoer);
          zetInstelling('github_token', invoer);
          zetInstelling('github_login', wie.login);
          zetInstelling('github_scopes', wie.scopes);
          github.zetToken(invoer);
          zetInstelling('projecten_fout', '');
        } catch (e) { return fout(res, 400, 'Token niet opgeslagen: ' + e.message); }
      } else {
        zetInstelling('github_token', '');
        zetInstelling('github_login', '');
        zetInstelling('github_scopes', '');
        github.zetToken('');
      }
    }
    if (body.slack_aan !== undefined) zetInstelling('slack_aan', body.slack_aan ? '1' : '0');
    if (body.slack_herstel !== undefined) zetInstelling('slack_herstel', body.slack_herstel ? '1' : '0');
    return json(res, 200, {
      ok: true, github_token: github.token() ? 'ingesteld' : 'niet ingesteld',
      github_login: instelling('github_login'), agent_token: instelling('agent_token'),
      slack_webhook: instelling('slack_webhook'), slack_aan: instelling('slack_aan') === '1',
      slack_herstel: instelling('slack_herstel', '1') === '1',
    });
  }

  // ── zelf bijwerken ─────────────────────────────────────────────────────────
  // Controleert of de nieuwste versie op GitHub al draait; uitvoeren vervangt de
  // bestanden en laat systemd het proces herstarten.
  if (pad === '/api/update' && methode === 'GET') {
    const hier = update.lokaal();
    return json(res, 200, { versie: hier.versie, sha: hier.sha, geinstalleerd: hier.geinstalleerd, repo: update.REPO, herstart: process.env.WM_UPDATE_RESTART !== '0' });
  }
  if (pad === '/api/update/controleer' && methode === 'POST') {
    try { return json(res, 200, await update.controleer(github.token())); }
    catch (e) { return fout(res, 400, 'Controle mislukt: ' + e.message); }
  }
  if (pad === '/api/update/uitvoeren' && methode === 'POST') {
    try {
      const uit = await update.uitvoeren(github.token());
      db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)')
        .run(nu(), 'bijgewerkt', '', 'Monitor bijgewerkt naar ' + String(uit.sha || '').slice(0, 7));
      // systemd start de dienst opnieuw (Restart=always); de gebruiker hoeft
      // niets te doen. Zonder systemd blijft de oude code draaien tot een herstart.
      if (!uit.al_actueel && process.env.WM_UPDATE_RESTART !== '0') setTimeout(() => process.exit(0), 600);
      return json(res, 200, uit);
    } catch (e) { return fout(res, 400, 'Bijwerken mislukt: ' + e.message); }
  }

  // Testbericht: laat meteen zien of de webhook werkt, zonder te wachten op een
  // echte storing. Verstuurt niets als er geen webhook is ingesteld.
  if (pad === '/api/slack/test' && methode === 'POST') {
    const webhook = instelling('slack_webhook');
    if (!webhook) return fout(res, 400, 'Vul eerst een Slack-webhook in');
    const uit = await slack.meldAlert(webhook, {
      soort: 'test', bericht: 'Testmelding vanuit Werdens Monitor — de koppeling werkt.',
      ip: '127.0.0.1', op: nu(),
    }, { basis: BASIS });
    if (!uit.ok) {
      zetInstelling('slack_laatst_fout', nu() + ' — ' + uit.fout);
      return fout(res, 502, uit.fout);
    }
    zetInstelling('slack_laatst', nu());
    zetInstelling('slack_laatst_fout', '');
    return json(res, 200, { ok: true, verzonden: nu() });
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
  if (delen[2] === 'hosts' && !delen[3] && methode === 'GET') {
    return json(res, 200, { hosts: hosts.lijst().map((h) => hosts.beeld(h)) });
  }
  if (delen[2] === 'hosts' && delen[3] && methode === 'GET') {
    const h = hosts.een(decodeURIComponent(delen[3]));
    if (!h) return fout(res, 404, 'Onbekend IP-adres');
    return json(res, 200, { host: hosts.beeld(h, true), alerts: hosts.alerts(h.ip) });
  }
  if (delen[2] === 'alerts' && methode === 'GET') {
    return json(res, 200, { alerts: hosts.openAlerts() });
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
  zorgLokaleServer();
  server.listen(POORT, () => console.log('Werdens Monitor luistert op poort ' + POORT));
  setTimeout(() => meetRonde().catch(() => {}), 1500);
  setTimeout(() => serverRonde().catch(() => {}), 2500);
  setInterval(() => serverRonde().catch(() => {}), 30e3);
  setTimeout(() => apparaten.ronde().catch(() => {}), 4000);
  setInterval(() => apparaten.ronde().catch(() => {}), 60e3);
  setTimeout(() => { if (instelling('agent_token')) verversProjecten(); }, 5000);
  setInterval(() => meetRonde().catch(() => {}), 30e3);
  setTimeout(() => hostRonde().catch(() => {}), 3500);
  setInterval(() => hostRonde().catch(() => {}), 60e3);
  setInterval(() => { try { escaleer(); } catch (e) { console.error('Escalatie mislukt: ' + e.message); } }, 5 * 60e3);
  setInterval(() => { if (!ververstBezig) verversProjecten(); }, 15 * 60e3);
  setInterval(() => db.prepare('DELETE FROM sessies WHERE verloopt < ?').run(nu()), 3600e3);
}

module.exports = { server, db, app: { overzicht, meetSite, siteBeeld, ticketVanBody, siteVanBody }, tickets, sites, projecten, sessies, meld, apparaten, wachtwoordAfpruk: wachtwoordAfdruk };