'use strict';
// Vult een lege database met een paar voorbeelden, zodat het dashboard meteen
// iets toont. Gebruik: DB_PATH=/tmp/demo.db node scripts/seed-demo.js
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const dbPad = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'monitor.db');
fs.mkdirSync(path.dirname(dbPad), { recursive: true });
const db = new DatabaseSync(dbPad);
const nu = () => new Date().toISOString();
const scrypt = (w, z) => crypto.scryptSync(String(w), z, 64).toString('hex');
const afdruk = (w) => { const z = crypto.randomBytes(16).toString('hex'); return z + ':' + scrypt(w, z); };

// tabellen staan er al als de app één keer gestart is; anders zelf aanmaken
db.exec(`
CREATE TABLE IF NOT EXISTS instellingen(sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessies(token TEXT PRIMARY KEY, aangemaakt TEXT NOT NULL, verloopt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sites(id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, url TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '', stats_url TEXT NOT NULL DEFAULT '',
  interval_s INTEGER NOT NULL DEFAULT 60, actief INTEGER NOT NULL DEFAULT 1, aangemaakt TEXT NOT NULL,
  stats_json TEXT NOT NULL DEFAULT '', stats_op TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS controles(id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, op TEXT NOT NULL,
  ok INTEGER NOT NULL, code INTEGER, ms INTEGER, versie TEXT NOT NULL DEFAULT '', bytes INTEGER, tls_dagen INTEGER,
  titel TEXT NOT NULL DEFAULT '', fout TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS projecten(naam TEXT PRIMARY KEY, url TEXT NOT NULL DEFAULT '',
  zichtbaarheid TEXT NOT NULL DEFAULT '', taal TEXT NOT NULL DEFAULT '', beschrijving TEXT NOT NULL DEFAULT '',
  versie TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', commit_sha TEXT NOT NULL DEFAULT '',
  commit_bericht TEXT NOT NULL DEFAULT '', commit_datum TEXT NOT NULL DEFAULT '', ci_status TEXT NOT NULL DEFAULT '',
  issues INTEGER NOT NULL DEFAULT 0, bijgewerkt TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
  fout TEXT NOT NULL DEFAULT '', opgehaald TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS hosts(ip TEXT PRIMARY KEY, naam TEXT NOT NULL DEFAULT '', notitie TEXT NOT NULL DEFAULT '',
  laatste_scan TEXT NOT NULL DEFAULT '', poorten TEXT NOT NULL DEFAULT '', diensten TEXT NOT NULL DEFAULT '',
  hostnaam TEXT NOT NULL DEFAULT '', actief INTEGER NOT NULL DEFAULT 1, interval_s INTEGER NOT NULL DEFAULT 300,
  ping_ms INTEGER, tls_dagen INTEGER, tls_verloopt TEXT NOT NULL DEFAULT '', aangemaakt TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1, fout TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS host_controles(id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, op TEXT NOT NULL,
  ok INTEGER NOT NULL, poorten INTEGER NOT NULL DEFAULT 0, ping_ms INTEGER, tls_dagen INTEGER, fout TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, soort TEXT NOT NULL,
  bericht TEXT NOT NULL, op TEXT NOT NULL, gezien INTEGER NOT NULL DEFAULT 0, opgelost TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS onderhoud(id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, van TEXT NOT NULL,
  tot TEXT NOT NULL, reden TEXT NOT NULL DEFAULT '', aangemaakt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gebeurtenissen(id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, soort TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '', tekst TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL DEFAULT '',
  titel TEXT NOT NULL, omschrijving TEXT NOT NULL DEFAULT '', prioriteit TEXT NOT NULL DEFAULT 'normaal',
  status TEXT NOT NULL DEFAULT 'open', aangemaakt TEXT NOT NULL, bijgewerkt TEXT NOT NULL,
  ai_onderzoek TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS berichten(id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
  auteur TEXT NOT NULL DEFAULT '', rol TEXT NOT NULL DEFAULT 'tom', bericht TEXT NOT NULL, op TEXT NOT NULL);
`);

const zet = db.prepare('INSERT INTO instellingen(sleutel,waarde) VALUES(?,?) ON CONFLICT(sleutel) DO UPDATE SET waarde=excluded.waarde');
if (!db.prepare("SELECT 1 FROM instellingen WHERE sleutel='admin_hash'").get()) {
  zet.run('admin_hash', afdruk(process.env.ADMIN_PASSWORD || 'demo1234'));
  zet.run('admin_naam', 'Tom');
}
if (!db.prepare("SELECT 1 FROM instellingen WHERE sleutel='agent_token'").get()) {
  zet.run('agent_token', crypto.randomBytes(24).toString('hex'));
}

const siteZet = db.prepare(`INSERT INTO sites(naam,url,ip,repo,stats_url,interval_s,actief,aangemaakt,stats_json,stats_op)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);
const controleZet = db.prepare(`INSERT INTO controles(site_id,op,ok,code,ms,versie,bytes,tls_dagen,titel,fout)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);

const sites = [
  { naam: 'Thuis — VoorraadThuis', url: 'https://thuis.werdensmedia.net/', ip: '192.168.1.50', repo: 'voorraadthuis-app', stats: { gebruikers: '6', bestanden: '1.284', database_mb: '18,4', laatste_backup: 'vannacht 03:00' } },
  { naam: 'Bakken — QR-stickers', url: 'https://bakken.werdensmedia.net/', ip: '192.168.1.51', repo: 'bakken', stats: { gebruikers: '3', bestanden: '212', database_mb: '4,1', laatste_backup: 'vannacht 03:00' } },
  { naam: 'AkkoordKast', url: 'https://akkoordkast.werdensmedia.net/', ip: '192.168.1.52', repo: 'akkoordkast', stats: { gebruikers: '2', bestanden: '8.701 liedjes', database_mb: '96,2', laatste_backup: 'vannacht 03:10' } },
  { naam: 'Werdens Media — hoofdsite', url: 'https://werdensmedia.net/', ip: '192.168.1.10', repo: '', stats: null },
];

const bestaand = db.prepare('SELECT COUNT(*) n FROM sites').get().n;
if (!bestaand) {
  for (const s of sites) {
    const r = siteZet.run(s.naam, s.url, s.ip, s.repo, '', 300, 1, nu(), s.stats ? JSON.stringify(s.stats) : '', s.stats ? nu() : '');
    // 26 uur geschiedenis, één meting per uur, met een korte storing
    for (let i = 26; i >= 0; i--) {
      const op = new Date(Date.now() - i * 3600e3).toISOString();
      const storing = s.naam.startsWith('Bakken') && i === 7;
      const ms = storing ? null : 40 + ((i * 37) % 90);
      controleZet.run(r.lastInsertRowid, op, storing ? 0 : 1, storing ? 502 : 200, ms,
        s.repo ? '2.' + (4 + (i % 3)) + '.' + (i % 10) : '', storing ? null : 18000 + i * 211, 74, s.naam, storing ? 'Bad gateway tijdens deploy' : '');
    }
  }
}

const hostZet = db.prepare(`INSERT INTO hosts(ip,naam,notitie,laatste_scan,poorten,diensten,hostnaam,actief,interval_s,
  ping_ms,tls_dagen,tls_verloopt,aangemaakt,ok,fout) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const hcZet = db.prepare('INSERT INTO host_controles(ip,op,ok,poorten,ping_ms,tls_dagen,fout) VALUES(?,?,?,?,?,?,?)');
const alertZet = db.prepare('INSERT INTO alerts(ip,soort,bericht,op,gezien,opgelost) VALUES(?,?,?,?,?,?)');
const gebZet = db.prepare('INSERT INTO gebeurtenissen(op,soort,ip,tekst) VALUES(?,?,?,?)');

const demoHosts = [
  { ip: '192.168.1.50', naam: 'proxmox-thuis', hostnaam: 'thuis.werdensmedia.net', notitie: 'LXC 105 — VoorraadThuis',
    poorten: [22, 80, 443, 3000], ping: 2, tls: 61, diensten: [
      { poort: 22, naam: 'ssh', titel: '', server: '', code: null, url: '' },
      { poort: 443, naam: 'https', url: 'https://192.168.1.50/', code: 200, titel: 'Thuis — VoorraadThuis', server: 'nginx' }] },
  { ip: '192.168.1.10', naam: 'nas-werdens', hostnaam: 'nas.werdensmedia.net', notitie: 'NAS — back-ups en media',
    poorten: [22, 445, 5000, 5001], ping: 1, tls: null, diensten: [
      { poort: 22, naam: 'ssh', titel: '', server: '', code: null, url: '' },
      { poort: 5000, naam: 'http', url: 'http://192.168.1.10:5000/', code: 302, titel: 'Synology DiskStation', server: 'nginx' }] },
  { ip: '192.168.1.16', naam: 'hermes-agent', hostnaam: 'hermesagent', notitie: 'Hermes Agent — LXC',
    poorten: [22, 8080, 8099], ping: 1, tls: null, diensten: [
      { poort: 22, naam: 'ssh', titel: '', server: '', code: null, url: '' },
      { poort: 8080, naam: 'http', url: 'http://192.168.1.16:8080/', code: 200, titel: 'Werdens Monitor', server: '' }] },
  { ip: '192.168.1.1', naam: 'router', hostnaam: 'fritz.box', notitie: 'Router en firewall',
    poorten: [53, 80, 443], ping: 4, tls: 12, diensten: [
      { poort: 443, naam: 'https', url: 'https://192.168.1.1/', code: 200, titel: 'FRITZ!Box', server: 'FRITZ!Box' }] },
];

if (!db.prepare('SELECT COUNT(*) n FROM hosts').get().n) {
  for (const h of demoHosts) {
    hostZet.run(h.ip, h.naam, h.notitie, nu(), JSON.stringify(h.poorten), JSON.stringify(h.diensten), h.hostnaam,
      1, 300, h.ping, h.tls, h.tls ? new Date(Date.now() + h.tls * 86400e3).toISOString() : '', nu(), 1, '');
    for (let i = 23; i >= 0; i--) {
      const op = new Date(Date.now() - i * 3600e3).toISOString();
      hcZet.run(h.ip, op, 1, h.poorten.length, h.ping + (i % 3), h.tls, '');
    }
  }
  // Eén host die niet bereikbaar is, zodat de storingenlijst niet leeg is.
  hostZet.run('192.168.1.77', 'werkplek-tom', 'Werkplek beneden', nu(), '[]', '[]', '', 1, 300, null, null, '', nu(), 0, 'Geen open poorten');
  for (let i = 4; i >= 0; i--) {
    const op = new Date(Date.now() - i * 3600e3).toISOString();
    hcZet.run('192.168.1.77', op, 0, 0, null, null, 'Geen open poorten');
  }
  alertZet.run('192.168.1.77', 'host neer', 'Host is niet meer bereikbaar (geen open poorten)', nu(), 0, '');
  alertZet.run('192.168.1.1', 'certificaat', 'TLS-certificaat verloopt over 12 dagen', nu(), 0, '');
  gebZet.run(nu(), 'alert', '192.168.1.77', 'Host 192.168.1.77 reageert niet meer');
  gebZet.run(nu(), 'host toegevoegd', '192.168.1.16', 'Host 192.168.1.16 toegevoegd');
}

if (!db.prepare('SELECT COUNT(*) n FROM tickets').get().n) {
  const t1 = db.prepare(`INSERT INTO tickets(ip,titel,omschrijving,prioriteit,status,aangemaakt,bijgewerkt)
    VALUES(?,?,?,?,?,?,?)`).run('192.168.1.50', 'Bakken laadt traag na deploy', 'Sinds de update van gisteren duurt het scannen van een QR-sticker ruim acht seconden.', 'hoog', 'in behandeling', nu(), nu());
  db.prepare('INSERT INTO berichten(ticket_id,auteur,rol,bericht,op) VALUES(?,?,?,?,?)')
    .run(t1.lastInsertRowid, 'Tom', 'tom', 'Sinds de update van gisteren duurt het scannen van een QR-sticker ruim acht seconden.', nu());
  db.prepare('INSERT INTO berichten(ticket_id,auteur,rol,bericht,op) VALUES(?,?,?,?,?)')
    .run(t1.lastInsertRowid, 'AI-agent', 'agent', 'Ik heb de logs van de LXC bekeken: de SQLite-query op stickers doet 6,2 s. Wil je dat ik de index op barcode toevoeg?', nu());

  const t2 = db.prepare(`INSERT INTO tickets(ip,titel,omschrijving,prioriteit,status,aangemaakt,bijgewerkt)
    VALUES(?,?,?,?,?,?,?)`).run('192.168.1.10', 'Schijf NAS bijna vol', 'De back-upschijf zit op 91%.', 'kritiek', 'open', nu(), nu());
  db.prepare('INSERT INTO berichten(ticket_id,auteur,rol,bericht,op) VALUES(?,?,?,?,?)')
    .run(t2.lastInsertRowid, 'Tom', 'tom', 'De back-upschijf zit op 91%.', nu());
}

console.log('Demodata in ' + dbPad);
db.close();
