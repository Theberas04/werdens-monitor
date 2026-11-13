// Eigen software op het netwerk: Tom's apps draaien niet allemaal op deze
// machine. Deze module loopt het LAN langs en kijkt per open poort of er een
// app van Tom achter zit.
//
// Herkennen gaat in twee stappen:
//  1. Het vingerafdruk-bestand: /.well-known/werdens-app.json (of
//     /werdens-app.json) met {"naam":"…","versie":"…","repo":"…"}. Ook een
//     <meta name="werdens-app" content="naam|versie|repo"> werkt.
//  2. De paginatitel, vergeleken met de titels van Tom's eigen apps. Zo worden
//     ook apps gevonden die (nog) geen vingerafdruk-bestand hebben.
//
// Alleen apps die zich zo identificeren komen in de lijst; een router of
// printer met een webpagina wordt dus niet als "software van Tom" geteld.
const http = require('node:http');
const https = require('node:https');
const netwerk = require('./netwerk');

// Poorten waarop een eigen web-app normaal luistert. Klein houden: dit is een
// gerichte zoektocht, geen volledige poortscan. Via EIGENAPPS_POORTEN te
// overschrijven (komma-gescheiden).
const APP_POORTEN = [80, 443, 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8081, 8090, 8099, 9000];
const TLS_POORTEN = new Set([443, 8443]);
const VINGERAFDRUK_PADEN = ['/.well-known/werdens-app.json', '/werdens-app.json'];
const MAX_HTML = 200 * 1024;

function poorten() {
  const ruw = String(process.env.EIGENAPPS_POORTEN || '').trim();
  if (!ruw) return APP_POORTEN.slice();
  const lijst = ruw.split(',').map((d) => Number(String(d).trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return lijst.length ? [...new Set(lijst)] : APP_POORTEN.slice();
}

// De titels van Tom's eigen apps. Nieuwe apps komen er automatisch bij zodra ze
// een vingerafdruk-bestand hebben; deze lijst is de terugval voor apps die dat
// nog niet hebben.
const BEKEND = [
  { naam: 'VoorraadThuis', repo: 'Theberas04/voorraadthuis', titel: /^VoorraadThuis\b/i },
  { naam: 'AkkoordKast', repo: 'Theberas04/akkoordkast', titel: /^AkkoordKast\b/i },
  { naam: 'BuildAfter', repo: 'Theberas04/buildafter', titel: /^Build After Generator\b/i },
  { naam: 'Bakken', repo: 'Theberas04/bakken', titel: /^Bakken\b/i },
  { naam: 'Kledingkast', repo: 'Theberas04/kledingkast', titel: /^Kledingkast\b/i },
  { naam: 'Zittesj', repo: 'Theberas04/zittesj', titel: /^Zittesj\b/i },
  { naam: 'BeatSync Studio', repo: 'Theberas04/beatsync-studio', titel: /^BeatSync Studio\b/i },
  { naam: 'Meldkamerspel', repo: 'Theberas04/meldkamerspel-android-overlay', titel: /^Meldkamerspel\b/i },
  { naam: 'Werdens Media Encoder', repo: 'Theberas04/media-encoder', titel: /^Werdens Media Encoder\b/i },
  { naam: 'Werdens Monitor', repo: 'Theberas04/werdens-monitor', titel: /^Werdens Monitor\b/i },
];

function titelVan(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').trim().slice(0, 120);
}

// <meta name="werdens-app" content="naam|versie|repo"> of een JSON-object in
// content. Geeft hetzelfde vorm terug als het vingerafdruk-bestand.
function metaVan(html) {
  const m = /<meta[^>]+name=["']werdens-app["'][^>]*>/i.exec(String(html || ''));
  if (!m) return null;
  // content mag met " of ' omgeven zijn. Binnen '...' staat vaak JSON met
  // dubbele aanhalingstekens; die mogen dus niet als afsluiter tellen.
  const c = /content=(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
  if (!c) return null;
  const ruw = String(c[1] !== undefined ? c[1] : c[2]).trim();
  if (!ruw) return null;
  if (ruw.startsWith('{')) {
    try { return normaliseer(JSON.parse(ruw)); } catch { return null; }
  }
  const [naam, versie, repo] = ruw.split('|').map((d) => String(d || '').trim());
  if (!naam) return null;
  return { naam: naam.slice(0, 80), versie: (versie || '').slice(0, 40), repo: (repo || '').slice(0, 200), sha: '' };
}

function normaliseer(o) {
  if (!o || typeof o !== 'object') return null;
  const naam = String(o.naam || o.name || '').trim().slice(0, 80);
  if (!naam) return null;
  return {
    naam,
    versie: String(o.versie || o.version || '').trim().slice(0, 40),
    repo: String(o.repo || o.repository || '').trim().slice(0, 200),
    sha: String(o.sha || o.commit || '').trim().slice(0, 64),
  };
}

// Eén GET, met korte time-out. Een apparaat dat traag of stuk is mag de hele
// zoektocht niet ophouden; daarom geven we altijd null terug in plaats van te
// gooien.
function haal(url, timeout = 1200) {
  return new Promise((resolve) => {
    let klaar = false;
    const af = (v) => { if (!klaar) { klaar = true; resolve(v); } };
    let req;
    try {
      const lib = url.startsWith('https:') ? https : http;
      req = lib.get(url, {
        timeout,
        rejectUnauthorized: false,
        headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'user-agent': 'WerdensMonitor/1.13' },
      }, (res) => {
        if (!res.statusCode || res.statusCode >= 400) { res.resume(); return af(null); }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          data += d;
          if (data.length > MAX_HTML) { try { req.destroy(); } catch { /* al weg */ } af(null); }
        });
        res.on('end', () => af({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: data }));
      });
    } catch { return af(null); }
    req.on('timeout', () => { try { req.destroy(); } catch { /* al weg */ } af(null); });
    req.on('error', () => af(null));
  });
}

function basisUrl(host, poort) {
  // IPv6-adressen tussen blokhaken; de netwerkscan werkt met IPv4, maar dit
  // voorkomt gekke URL's als er ooit een IPv6-adres langskomt.
  const h = String(host).includes(':') ? '[' + host + ']' : host;
  return (TLS_POORTEN.has(Number(poort)) ? 'https://' : 'http://') + h + ':' + poort;
}

async function vingerafdruk(host, poort, timeout = 1200) {
  const basis = basisUrl(host, poort);
  for (const pad of VINGERAFDRUK_PADEN) {
    const r = await haal(basis + pad, timeout);
    if (!r || !r.body) continue;
    try { const app = normaliseer(JSON.parse(r.body)); if (app) return app; } catch { /* geen JSON */ }
  }
  return null;
}

// Herkent één adres:poort als een app van Tom. Geeft null als het iets anders
// is (router, printer, willekeurige webserver).
async function herken(host, poort, { timeout = 1200 } = {}) {
  const vinger = await vingerafdruk(host, poort, timeout);
  if (vinger) return { ...vinger, herkend: 'vingerafdruk' };

  const pagina = await haal(basisUrl(host, poort) + '/', timeout);
  if (!pagina || !pagina.body) return null;
  const meta = metaVan(pagina.body);
  if (meta) return { ...meta, herkend: 'meta' };

  const titel = titelVan(pagina.body);
  if (!titel) return null;
  const bekend = BEKEND.find((b) => b.titel.test(titel));
  if (!bekend) return null;
  return { naam: bekend.naam, versie: '', repo: bekend.repo, sha: '', titel, herkend: 'titel' };
}

// Het hele LAN langs. `ontdekker` en `herkenner` zijn instelbaar zodat de tests
// geen echt netwerk nodig hebben.
async function zoek({
  subnetten: subs, poorten: poortlijst, timeout = 300, gelijktijdig = 64,
  maxMs = 45000, ontdekker = netwerk.ontdek, herkenner = herken,
} = {}) {
  const begin = Date.now();
  const lijst = subs || netwerk.subnetten();
  const teZoeken = poortlijst || poorten();
  const uit = [];
  const gezien = new Set();

  for (const subnet of lijst) {
    if (Date.now() - begin > maxMs) break;
    let hosts = [];
    try {
      hosts = await ontdekker(subnet, { poorten: teZoeken, timeout, gelijktijdig });
    } catch { continue; }

    const kandidaten = [];
    for (const h of hosts) {
      // Het eigen adres slaat de netwerkscan over (poorten leeg); die apps
      // staan al in de lokale lijst.
      for (const p of h.poorten || []) {
        if (!teZoeken.includes(Number(p))) continue;
        kandidaten.push({ host: h.ip, poort: Number(p), hostnaam: h.hostnaam || '' });
      }
    }

    let i = 0;
    const werk = async () => {
      while (i < kandidaten.length) {
        if (Date.now() - begin > maxMs) return;
        const k = kandidaten[i++];
        const sleutel = k.host + ':' + k.poort;
        if (gezien.has(sleutel)) continue;
        let app = null;
        try { app = await herkenner(k.host, k.poort, { timeout: 1200 }); } catch { app = null; }
        if (!app) continue;
        gezien.add(sleutel);
        uit.push({ ...k, ...app });
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, kandidaten.length)) }, werk));
  }

  uit.sort((a, b) => String(a.naam).localeCompare(String(b.naam), 'nl'));
  return uit;
}

module.exports = {
  APP_POORTEN, TLS_POORTEN, VINGERAFDRUK_PADEN, BEKEND,
  poorten, titelVan, metaVan, normaliseer, haal, basisUrl, vingerafdruk, herken, zoek,
};