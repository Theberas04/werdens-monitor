'use strict';
// Test: de meldpagina op een EIGEN IP-adres. Start de app als los proces met
// PUBLIEK_BIND op een tweede adres en controleert dat de pagina daar wel komt
// en op het oude adres niet bestaat. Draait op 127.0.0.2, een adres dat op
// Linux standaard bij de loopback hoort (127.0.0.0/8).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORTEL = path.join(__dirname, '..');
const PUBLIEK_IP = '127.0.0.2';

function vrijepoort() {
  return new Promise((klaar, mis) => {
    const s = net.createServer();
    s.once('error', mis);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => klaar(p));
    });
  });
}

// Wacht tot een adres antwoordt (of tot de tijd om is).
async function wachtOp(url, ms = 15000) {
  const eind = Date.now() + ms;
  while (Date.now() < eind) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return r;
    } catch { /* nog niet bereikbaar */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('niet bereikbaar binnen de tijd: ' + url);
}

test('de meldpagina draait op een eigen IP-adres en nergens anders', async (t) => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-ip-'));
  const dashboard = await vrijepoort();
  const publiek = await vrijepoort();

  const kind = spawn(process.execPath, ['server.js'], {
    cwd: WORTEL,
    env: {
      ...process.env,
      PORT: String(dashboard),
      PUBLIEK_POORT: String(publiek),
      PUBLIEK_BIND: PUBLIEK_IP,
      DB_PATH: path.join(TMP, 'monitor.db'),
      ADMIN_PASSWORD: 'testwachtwoord123',
      GITHUB_TOKEN: '',
      SLACK_WEBHOOK: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  kind.stdout.on('data', (b) => { log += b.toString(); });
  kind.stderr.on('data', (b) => { log += b.toString(); });

  t.after(() => {
    try { kind.kill('SIGKILL'); } catch { /* al weg */ }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const publiekBasis = 'http://' + PUBLIEK_IP + ':' + publiek;
  const dashboardBasis = 'http://127.0.0.1:' + dashboard;

  // 1. De meldpagina komt op het eigen adres.
  const r = await wachtOp(publiekBasis + '/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
  assert.match(log, new RegExp('Publieke meldpagina luistert op ' + PUBLIEK_IP.replace(/\./g, '\\.') + ':' + publiek),
    'het log noemt het eigen adres');

  const pagina = await wachtOp(publiekBasis + '/');
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /Een probleem melden/);

  // 2. Op het oude adres (127.0.0.1) bestaat die poort niet: de luisteraar zit
  //    echt aan één adres vast en niet aan alle adressen.
  let geweigerd = false;
  try {
    await fetch('http://127.0.0.1:' + publiek + '/');
  } catch {
    geweigerd = true;
  }
  assert.equal(geweigerd, true, 'op 127.0.0.1:' + publiek + ' hoort niets te luisteren');

  // 3. Het dashboard blijft gewoon werken en stuurt /melden door naar de
  //    meldpagina op het eigen adres.
  const thuis = await wachtOp(dashboardBasis + '/');
  assert.equal(thuis.status, 200);
  const doorverwijzing = await fetch(dashboardBasis + '/melden', { redirect: 'manual' });
  assert.equal(doorverwijzing.status, 302, 'het dashboard stuurt door');
  assert.equal(doorverwijzing.headers.get('location'), publiekBasis + '/melden');

  // 4. Een melding via het eigen adres wordt een gewoon ticket in dezelfde database.
  const melding = await fetch(publiekBasis + '/api/melden', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      titel: 'Melding op het eigen IP',
      omschrijving: 'De kassa op de balie start niet meer op.',
      categorie: 'hardware',
      impact: 'hoog',
      urgentie: 'hoog',
      klant_naam: 'Balie',
      klant_email: 'balie@example.nl',
      geopend: Date.now() - 5000,
    }),
  });
  assert.equal(melding.status, 201);
  const uit = await melding.json();
  assert.equal(uit.ok, true);
  assert.equal(uit.ticket.prioriteit, 'kritiek');

  const inlog = await fetch(dashboardBasis + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wachtwoord: 'testwachtwoord123' }),
  });
  assert.equal(inlog.status, 200);
  const koek = String(inlog.headers.get('set-cookie') || '').split(';')[0];

  const tickets = await (await fetch(dashboardBasis + '/api/tickets', { headers: { cookie: koek } })).json();
  assert.ok(tickets.tickets.some((x) => x.id === uit.ticket.id), 'het ticket staat in de dashboardlijst');

  // 5. De instellingen laten zien dat de luisteraar op dat adres staat.
  const inst = await (await fetch(dashboardBasis + '/api/instellingen', { headers: { cookie: koek } })).json();
  assert.equal(inst.publiek_luistert, true);
  assert.equal(inst.publiek_bind, PUBLIEK_IP);
  assert.equal(inst.publiek_adres, publiekBasis);
  assert.ok(Array.isArray(inst.publiek_adressen));
});

test('een onbekend PUBLIEK_BIND laat het dashboard gewoon draaien', async (t) => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-ipfout-'));
  const dashboard = await vrijepoort();
  const publiek = await vrijepoort();

  const kind = spawn(process.execPath, ['server.js'], {
    cwd: WORTEL,
    env: {
      ...process.env,
      PORT: String(dashboard),
      PUBLIEK_POORT: String(publiek),
      PUBLIEK_BIND: '203.0.113.7', // dokumentatie-adres: bestaat hier niet
      DB_PATH: path.join(TMP, 'monitor.db'),
      ADMIN_PASSWORD: 'testwachtwoord123',
      GITHUB_TOKEN: '',
      SLACK_WEBHOOK: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  kind.stdout.on('data', (b) => { log += b.toString(); });
  kind.stderr.on('data', (b) => { log += b.toString(); });

  t.after(() => {
    try { kind.kill('SIGKILL'); } catch { /* al weg */ }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const dashboardBasis = 'http://127.0.0.1:' + dashboard;
  const thuis = await wachtOp(dashboardBasis + '/healthz');
  assert.equal(thuis.status, 200, 'het dashboard blijft bereikbaar');

  await new Promise((r) => setTimeout(r, 1500));
  assert.match(log, /Publieke meldpagina start niet/, 'de fout staat in het log');
  assert.match(log, /staat niet op deze machine/, 'het log legt uit dat het adres niet bestaat');

  const inlog = await fetch(dashboardBasis + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wachtwoord: 'testwachtwoord123' }),
  });
  const koek = String(inlog.headers.get('set-cookie') || '').split(';')[0];
  const inst = await (await fetch(dashboardBasis + '/api/instellingen', { headers: { cookie: koek } })).json();
  assert.equal(inst.publiek_luistert, false);
  assert.ok(inst.publiek_fout, 'de instellingen noemen de fout');
});
