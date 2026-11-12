'use strict';
// Tests voor de publieke meldpagina op een eigen adres: de tweede luisteraar
// mag alleen de meldpagina en haar API bedienen, nooit het dashboard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-publiek-'));
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.ADMIN_PASSWORD = 'testwachtwoord123';
process.env.GITHUB_TOKEN = '';
process.env.PORT = '0';
process.env.PUBLIEK_POORT = '0';

const { server, publiekServer, db } = require('../server');

let hoofdBasis;
let publiekBasis;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => publiekServer.listen(0, '127.0.0.1', r));
  hoofdBasis = 'http://127.0.0.1:' + server.address().port;
  publiekBasis = 'http://127.0.0.1:' + publiekServer.address().port;
});

test.after(() => {
  server.close();
  publiekServer.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('de publieke pagina staat op / en /melden', async () => {
  for (const pad of ['/', '/melden', '/melden.html']) {
    const r = await fetch(publiekBasis + pad);
    assert.equal(r.status, 200, pad);
    const html = await r.text();
    assert.match(html, /Werdens Media/, pad + ' toont het formulier');
    assert.match(html, /api\/melden/, pad + ' laadt de meld-API');
  }
});

test('de publieke luisteraar levert de info-route', async () => {
  const r = await fetch(publiekBasis + '/api/melden/info');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.categorieen) && d.categorieen.length > 0);
});

test('de publieke luisteraar stuurt het dashboard niet mee', async () => {
  for (const pad of ['/api/overzicht', '/api/tickets', '/api/instellingen', '/api/projecten']) {
    const r = await fetch(publiekBasis + pad);
    assert.equal(r.status, 404, pad + ' hoort hier niet te bestaan');
    const t = await r.text();
    assert.doesNotMatch(t, /tickets|projecten|instellingen/i, pad + ' lekt geen dashboardinhoud');
  }
});

test('de publieke luisteraar weigert de inlogpagina en de dashboard-API met POST', async () => {
  const r = await fetch(publiekBasis + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"wachtwoord":"x"}' });
  assert.equal(r.status, 404);
});

test('een melding via de publieke pagina maakt een ticket', async () => {
  const voor = (await (await fetch(hoofdBasis + '/api/tickets', { headers: { cookie: await inloggen() } })).json()).tickets.length;
  const r = await fetch(publiekBasis + '/api/melden', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      titel: 'Testmelding via publieke pagina',
      omschrijving: 'De printer op de gang doet het niet.',
      categorie: 'hardware',
      impact: 'hoog',
      urgentie: 'hoog',
      klant_naam: 'Testklant',
      klant_email: 'test@example.nl',
      geopend: Date.now() - 5000,
    }),
  });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.ticket.prioriteit, 'kritiek');
  const na = (await (await fetch(hoofdBasis + '/api/tickets', { headers: { cookie: await inloggen() } })).json()).tickets.length;
  assert.equal(na, voor + 1, 'er is precies één ticket bij');
  const rij = db.prepare('SELECT kanaal, prioriteit FROM tickets WHERE id=?').get(d.ticket.id);
  assert.equal(rij.kanaal, 'meldpagina');
  assert.equal(rij.prioriteit, 'kritiek');
});

test('de honeypot bewaart niets', async () => {
  const voor = db.prepare('SELECT COUNT(*) n FROM tickets').get().n;
  const r = await fetch(publiekBasis + '/api/melden', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titel: 'Spam', website: 'https://spam.example', geopend: Date.now() - 5000 }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets').get().n, voor);
});

test('de publieke luisteraar heeft een eigen healthz', async () => {
  const r = await fetch(publiekBasis + '/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('merkbestanden zijn ook hier openbaar', async () => {
  const r = await fetch(publiekBasis + '/assets/werdens-media-logo.png');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /image\/png/);
});

let koek = '';
async function inloggen() {
  if (koek) return koek;
  const r = await fetch(hoofdBasis + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wachtwoord: 'testwachtwoord123' }),
  });
  koek = String(r.headers.get('set-cookie') || '').split(';')[0];
  return koek;
}
