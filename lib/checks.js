// Meten: een website ophalen (status, tijd, versie, TLS), optioneel een
// stats-endpoint uitlezen, en een host aftasten op open poorten.
// Alles met korte time-outs: de monitor mag nooit blijven hangen op een dode host.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { URL } = require('node:url');

const TIJD = Number(process.env.CHECK_TIMEOUT_MS || 8000);
const MAX_BODY = 300 * 1000;

function haal(url, opties = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Ongeldige URL')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Alleen http en https'));
    const lib = u.protocol === 'https:' ? https : http;
    const verzoek = lib.request(u, {
      method: 'GET',
      timeout: opties.timeout || TIJD,
      rejectUnauthorized: false,
      headers: {
        'user-agent': 'WerdensMonitor/1.0',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        connection: 'close',
      },
    }, (res) => {
      const brokken = [];
      let lengte = 0;
      res.on('data', (c) => {
        lengte += c.length;
        if (lengte <= MAX_BODY) brokken.push(c);
        else res.destroy();
      });
      const klaar = () => resolve({
        code: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(brokken).toString('utf8'),
        bytes: lengte,
        socket: res.socket,
      });
      res.on('end', klaar);
      res.on('close', klaar);
      res.on('error', () => klaar());
    });
    verzoek.on('timeout', () => verzoek.destroy(new Error('Time-out na ' + Math.round(TIJD / 1000) + ' s')));
    verzoek.on('error', reject);
    verzoek.end();
  });
}

const META = [
  /<meta[^>]+name=["'](?:version|app-version|applicatieversie)["'][^>]+content=["']([^"']{1,40})["']/i,
  /<meta[^>]+content=["']([^"']{1,40})["'][^>]+name=["'](?:version|app-version)["']/i,
  /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,60})["']/i,
];
const VERSIE_IN_TEKST = [
  /"version"\s*:\s*"([0-9][0-9a-zA-Z.\-+]{1,30})"/,
  /\bversie\s*[:=]?\s*v?([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+][0-9a-zA-Z.]+)?)/i,
  /\bv([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9a-zA-Z.]+)?)\b/,
];

// De versie staat lang niet altijd in de pagina; kijk in deze volgorde:
// kopregels, een meta-tag, en pas daarna losse tekst in de pagina.
function vindVersie(res) {
  const h = res.headers || {};
  for (const naam of ['x-app-version', 'x-version', 'x-app-versie', 'x-powered-by-version']) {
    if (h[naam]) return String(h[naam]).trim().slice(0, 40);
  }
  const body = res.body || '';
  for (const re of META) {
    const m = body.match(re);
    if (m) return m[1].trim().slice(0, 60);
  }
  for (const re of VERSIE_IN_TEKST) {
    const m = body.match(re);
    if (m) return (m[1] || '').trim().slice(0, 40);
  }
  return '';
}

function titelVan(body) {
  const m = (body || '').match(/<title[^>]*>([\s\S]{1,140}?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function tlsDagen(socket) {
  try {
    if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
    const cert = socket.getPeerCertificate();
    if (!cert || !cert.valid_to) return null;
    const dagen = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
    return Number.isFinite(dagen) ? dagen : null;
  } catch { return null; }
}

// Eén meting van een site. Geeft altijd een object terug; fouten worden gegevens.
async function controleerSite(site) {
  const start = Date.now();
  const resultaat = {
    op: new Date().toISOString(), ok: 0, code: null, ms: null, versie: '',
    bytes: null, tls_dagen: null, titel: '', fout: '',
  };
  try {
    const res = await haal(site.url);
    resultaat.ms = Date.now() - start;
    resultaat.code = res.code;
    resultaat.bytes = res.bytes;
    resultaat.ok = res.code >= 200 && res.code < 400 ? 1 : 0;
    resultaat.titel = titelVan(res.body);
    resultaat.tls_dagen = tlsDagen(res.socket);
    resultaat.versie = vindVersie(res);
    if (!resultaat.ok) resultaat.fout = 'HTTP ' + res.code;
  } catch (e) {
    resultaat.ms = Date.now() - start;
    resultaat.fout = e.code === 'ENOTFOUND' ? 'Naam niet gevonden (DNS)'
      : e.code === 'ECONNREFUSED' ? 'Verbinding geweigerd'
      : e.code === 'CERT_HAS_EXPIRED' ? 'TLS-certificaat verlopen'
      : (e.message || 'Onbekende fout');
  }
  return resultaat;
}

// Een site mag een stats-endpoint publiceren met gebruikers, bestanden en
// databasegrootte. We bewaren alleen vlakke, korte waarden.
const STATS_TOEGESTAAN = ['versie', 'gebruikers', 'bestanden', 'database_mb', 'schijf_mb', 'omgeving', 'gestart', 'laatste_backup'];

function schoonStats(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const uit = {};
  for (const sleutel of STATS_TOEGESTAAN) {
    if (data[sleutel] === undefined || data[sleutel] === null) continue;
    const waarde = typeof data[sleutel] === 'object' ? JSON.stringify(data[sleutel]).slice(0, 80) : String(data[sleutel]);
    uit[sleutel] = waarde.slice(0, 80);
  }
  return Object.keys(uit).length ? uit : null;
}

async function haalStats(url) {
  if (!url) return null;
  try {
    const res = await haal(url, { timeout: 5000 });
    if (res.code !== 200) return null;
    return schoonStats(JSON.parse(res.body));
  } catch { return null; }
}

const VEEL_POORTEN = [22, 80, 443, 3000, 3306, 5000, 5432, 6379, 8006, 8080, 8443, 9000];

function poortOpen(ip, poort, timeout = 900) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let klaar = false;
    const af = (open) => { if (klaar) return; klaar = true; s.destroy(); resolve(open); };
    s.setTimeout(timeout);
    s.once('connect', () => af(true));
    s.once('timeout', () => af(false));
    s.once('error', () => af(false));
    try { s.connect(poort, ip); } catch { af(false); }
  });
}

// Aftasten van één los IP (de "aparte functie" voor Tom se ICT-tickets).
// Poorten parallel, elk met een korte time-out, en per open poort een titel.
async function scanHost(ip, poorten = VEEL_POORTEN) {
  const schoon = String(ip || '').trim();
  if (!net.isIP(schoon)) throw new Error('Geen geldig IP-adres');
  const open = [];
  await Promise.all(poorten.map(async (p) => { if (await poortOpen(schoon, p)) open.push(p); }));
  open.sort((a, b) => a - b);
  const diensten = [];
  for (const p of open.filter((x) => x === 80 || x === 443 || x === 8080 || x === 8443 || x === 3000 || x === 5000)) {
    const protocol = p === 443 || p === 8443 ? 'https' : 'http';
    const url = protocol + '://' + schoon + ':' + p + '/';
    try {
      const res = await haal(url, { timeout: 4000 });
      diensten.push({ poort: p, url, code: res.code, titel: titelVan(res.body), server: String(res.headers.server || '').slice(0, 60) });
    } catch (e) {
      diensten.push({ poort: p, url, code: null, titel: '', server: '', fout: e.message });
    }
  }
  return { ip: schoon, poorten: open, diensten, op: new Date().toISOString() };
}

module.exports = { controleerSite, haalStats, scanHost, haal, vindVersie, tlsDagen, VEEL_POORTEN, schoonStats };