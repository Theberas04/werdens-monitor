'use strict';
// Tests voor Werdens Monitor. Draaien met: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.ADMIN_PASSWORD = 'testwachtwoord123';
process.env.GITHUB_TOKEN = '';
process.env.PORT = '0';

const { server, db } = require('../server');

let basis;
let koek = '';
let agentToken = '';
let testSite;

function verzoek(pad, opties = {}) {
  const koppen = { ...(opties.koppen || {}) };
  if (koek) koppen.cookie = koek;
  return fetch(basis + pad, {
    method: opties.method || 'GET',
    headers: { 'content-type': 'application/json', ...koppen },
    body: opties.lichaam ? JSON.stringify(opties.lichaam) : undefined,
    redirect: 'manual',
  });
}
async function alsJson(pad, opties) {
  const r = await verzoek(pad, opties);
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, koppen: r.headers };
}

test.before(async () => {
  // Een nagebootste site met versie in een meta-tag en een stats-endpoint.
  testSite = http.createServer((req, res) => {
    if (req.url === '/api/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ versie: '2.3.4', gebruikers: 4, bestanden: 812, database_mb: 12.5 }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Testsite</title><meta name="version" content="2.3.4"></head><body>ok</body></html>');
  });
  await new Promise((r) => testSite.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = 'http://127.0.0.1:' + server.address().port;
  agentToken = db.prepare("SELECT waarde FROM instellingen WHERE sleutel='agent_token'").get().waarde;
});

test.after(() => {
  server.close();
  testSite.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('healthz antwoordt ok met eigen merkteken', async () => {
  const r = await verzoek('/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
  assert.equal(r.headers.get('x-werdensmonitor'), 'app');
});

test('zonder sessie geen gegevens, maar wel de inlogpagina', async () => {
  const api = await verzoek('/api/overzicht');
  assert.equal(api.status, 401);
  const pagina = await verzoek('/');
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /Werdens Monitor/);
  // Merk- en PWA-bestanden zijn bewust openbaar (logo op de inlogpagina).
  const merk = await verzoek('/assets/werdens-media-logo.png');
  assert.equal(merk.status, 200, 'logo moet zonder sessie laden');
  const favicon = await verzoek('/favicon.svg');
  assert.equal(favicon.status, 200, 'favicon is openbaar');
  // Alles buiten de merk- en PWA-allowlist blijft achter de login.
  const statisch = await verzoek('/sw.js');
  assert.equal(statisch.status, 302, 'overige bestanden pas na inloggen');
});

test('inloggen met het verkeerde en het juiste wachtwoord', async () => {
  const mis = await alsJson('/api/login', { method: 'POST', lichaam: { wachtwoord: 'fout' } });
  assert.equal(mis.status, 401);
  const goed = await verzoek('/api/login', { method: 'POST', lichaam: { wachtwoord: 'testwachtwoord123' } });
  assert.equal(goed.status, 200);
  const set = goed.headers.get('set-cookie');
  assert.match(set, /wm_sess=/);
  assert.match(set, /HttpOnly/);
  koek = set.split(';')[0];
  const ik = await alsJson('/api/ik');
  assert.equal(ik.status, 200);
});

test('sites: validatie, toevoegen, meten en stats', async () => {
  const fout = await alsJson('/api/sites', { method: 'POST', lichaam: { naam: 'Kapot', url: 'ftp://x' } });
  assert.equal(fout.status, 400);
  const zonder = await alsJson('/api/sites', { method: 'POST', lichaam: { url: 'http://example.org' } });
  assert.equal(zonder.status, 400);

  const poort = testSite.address().port;
  const nieuw = await alsJson('/api/sites', {
    method: 'POST',
    lichaam: { naam: 'Testsite', url: 'http://127.0.0.1:' + poort + '/', stats_url: 'http://127.0.0.1:' + poort + '/api/stats', interval_s: 60 },
  });
  assert.equal(nieuw.status, 201);
  const id = nieuw.data.site.id;

  const meting = await alsJson('/api/sites/' + id + '/controleer', { method: 'POST' });
  assert.equal(meting.status, 200);
  assert.equal(meting.data.meting.ok, 1);
  assert.equal(meting.data.meting.versie, '2.3.4');

  const detail = await alsJson('/api/sites/' + id);
  assert.equal(detail.data.site.stats.gebruikers, '4');
  assert.equal(detail.data.site.stats.bestanden, '812');
  assert.ok(detail.data.controles.length >= 1);

  const aanpassen = await alsJson('/api/sites/' + id, { method: 'PATCH', lichaam: { naam: 'Testsite 2', interval_s: 5 } });
  assert.equal(aanpassen.status, 200);
  assert.equal(aanpassen.data.site.naam, 'Testsite 2');
  assert.equal(aanpassen.data.site.interval_s, 30, 'interval wordt op minimaal 30 s geklemd');

  const overzicht = await alsJson('/api/overzicht');
  assert.equal(overzicht.status, 200);
  assert.equal(overzicht.data.samenvatting.sites, 1);
  assert.ok(Array.isArray(overzicht.data.sites[0].geschiedenis));
});

test('tickets: aanmaken, berichten, status en agent-token', async () => {
  const foutIp = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'X', ip: '999.1.1.1' } });
  assert.equal(foutIp.status, 400);

  const gemaakt = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Website traag', ip: '192.168.1.50', prioriteit: 'hoog', omschrijving: 'Sinds de update duurt laden 8 seconden.' } });
  assert.equal(gemaakt.status, 201);
  const id = gemaakt.data.ticket.id;

  const detail = await alsJson('/api/tickets/' + id);
  assert.equal(detail.data.berichten.length, 1, 'omschrijving wordt het eerste bericht');
  assert.equal(detail.data.ticket.status, 'open');
  assert.ok(detail.data.context);

  const bericht = await alsJson('/api/tickets/' + id + '/berichten', { method: 'POST', lichaam: { bericht: 'Ik kijk mee.' } });
  assert.equal(bericht.status, 201);
  assert.equal(bericht.data.berichten.length, 2);

  const mis = await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { status: 'bestaat-niet' } });
  assert.equal(mis.status, 400);
  const goed = await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { status: 'in behandeling' } });
  assert.equal(goed.data.ticket.status, 'in behandeling');

  // agent-API
  const zonderToken = await verzoek('/api/agent/tickets');
  assert.equal(zonderToken.status, 401);
  const agent = await fetch(basis + '/api/agent/tickets', { headers: { authorization: 'Bearer ' + agentToken } });
  assert.equal(agent.status, 200);
  const lijst = await agent.json();
  assert.ok(lijst.tickets.some((t) => t.id === id));

  const agentDetail = await fetch(basis + '/api/agent/tickets/' + id, { headers: { authorization: 'Bearer ' + agentToken } });
  assert.equal(agentDetail.status, 200);
  const agentBericht = await fetch(basis + '/api/agent/tickets/' + id + '/berichten', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + agentToken, 'content-type': 'application/json' },
    body: JSON.stringify({ bericht: 'Ik heb de logs bekeken.', status: 'wacht op Tom' }),
  });
  assert.equal(agentBericht.status, 201);
  const na = await alsJson('/api/tickets/' + id);
  assert.equal(na.data.ticket.status, 'wacht op Tom');
  assert.equal(na.data.berichten.at(-1).rol, 'agent');

  const geenBeheer = await fetch(basis + '/api/instellingen', { headers: { authorization: 'Bearer ' + agentToken } });
  assert.equal(geenBeheer.status, 401, 'agent-token geeft geen beheerdersrechten');
});

test('host aftasten weigert onzin en accepteert een lokaal adres', async () => {
  const fout = await alsJson('/api/hosts/scan', { method: 'POST', lichaam: { ip: 'niet-een-ip' } });
  assert.equal(fout.status, 400);
  const goed = await alsJson('/api/hosts/scan', { method: 'POST', lichaam: { ip: '127.0.0.1' } });
  assert.equal(goed.status, 200);
  assert.ok(Array.isArray(goed.data.scan.poorten));
});

test('statische bestanden, PWA en paden buiten public', async () => {
  for (const [pad, type] of [['/manifest.webmanifest', 'manifest'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/sw.js', 'javascript'], ['/favicon.svg', 'svg']]) {
    const r = await verzoek(pad);
    assert.equal(r.status, 200, pad + ' moet bestaan');
    assert.match(r.headers.get('content-type'), new RegExp(type === 'manifest' ? 'manifest' : type));
  }
  const verboden = await verzoek('/%2e%2e/server.js');
  assert.ok([403, 404].includes(verboden.status), 'pad buiten public moet geweigerd worden');
  const verboden2 = await verzoek('/..%2fserver.js');
  assert.ok([403, 404].includes(verboden2.status));
});

test('elk inline script compileert en elk script-bestand bestaat', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const blokken = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blokken.length, 1, 'één inline script in deze app');
  assert.doesNotThrow(() => new vm.Script(blokken[0]));
  const bronnen = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of bronnen) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', src.replace(/^\//, ''))), src + ' ontbreekt');
  }
});

test('de API beschermt zich tegen een protocol-relatief pad', async () => {
  const r = await fetch(basis + '///api/overzicht', { headers: { cookie: koek } });
  assert.ok([200, 404].includes(r.status));
  const nog = await alsJson('/api/overzicht');
  assert.equal(nog.status, 200, 'server leeft nog');
});