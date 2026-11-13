'use strict';
// Tests voor de eigen-software-laag: elke app is een git-map met een
// package.json; het dashboard leest de versie, controleert GitHub en kan
// bijwerken. Eén dashboard-login in plaats van een wachtwoord per app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-eigenapps-'));
process.env.EIGENAPPS_MAP = TMP;
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.ADMIN_PASSWORD = 'testwachtwoord123';
process.env.PORT = '0';
process.env.PUBLIEK_POORT = '0';

const eigenapps = require('../lib/eigenapps');
const { server, db } = require('../server');

function git(pad, ...args) {
  return execFileSync('git', ['-C', pad, ...args], { stdio: 'pipe' }).toString().trim();
}

function maakApp(naam, versie) {
  const pad = path.join(TMP, naam);
  fs.mkdirSync(pad, { recursive: true });
  fs.writeFileSync(path.join(pad, 'package.json'), JSON.stringify({ name: naam, version: versie }));
  git(pad, 'init', '-q', '-b', 'main');
  git(pad, 'config', 'user.email', 'test@example.com');
  git(pad, 'config', 'user.name', 'Test');
  git(pad, 'add', '.');
  git(pad, 'commit', '-q', '-m', 'eerste');
  return pad;
}

let basis = '';
let koek = '';

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(basis + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wachtwoord: 'testwachtwoord123' }),
  });
  koek = String(r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const vraag = (pad, opties = {}) => fetch(basis + pad, {
  method: opties.method || 'GET',
  headers: { 'content-type': 'application/json', cookie: koek, ...(opties.koppen || {}) },
  body: opties.lichaam ? JSON.stringify(opties.lichaam) : undefined,
});

test('isApp herkent een map met git en package.json', () => {
  const pad = maakApp('app-een', '1.0.0');
  assert.equal(eigenapps.isApp(pad), true);
  assert.equal(eigenapps.isApp(path.join(TMP, 'bestaat-niet')), false);
  assert.equal(eigenapps.isApp(TMP), false);
});

test('versie komt uit package.json', () => {
  const pad = maakApp('app-twee', '2.3.4');
  assert.equal(eigenapps.versie(pad), '2.3.4');
});

test('kandidaten vindt de apps onder de eigen map', () => {
  const pad = maakApp('app-drie', '3.0.0');
  const k = eigenapps.kandidaten();
  assert.ok(k.some((x) => x.pad === pad), 'app-drie staat in de kandidaten');
});

test('veiligPad weigert een map buiten de eigen map', () => {
  assert.throws(() => eigenapps.veiligPad('/etc'), /binnen/);
  assert.throws(() => eigenapps.veiligPad('/tmp/geen-app'), /bestaat niet|binnen/);
});

test('beeld toont versie, sha en schone werkmap', () => {
  const pad = maakApp('app-vier', '4.0.0');
  const b = eigenapps.beeld(pad);
  assert.equal(b.versie, '4.0.0');
  assert.equal(b.schoon, true);
  assert.ok(b.sha.length >= 7);
});

test('werkBij weigert een niet-schone werkmap', () => {
  const pad = maakApp('app-vijf', '5.0.0');
  fs.writeFileSync(path.join(pad, 'extra.txt'), 'x');
  assert.throws(() => eigenapps.werkBij(pad), /wijzigingen/);
});

test('werkBij haalt een nieuwe commit binnen', () => {
  const bare = path.join(TMP, 'origin.git');
  fs.mkdirSync(bare);
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  const bron = path.join(TMP, 'bron');
  fs.mkdirSync(bron);
  fs.writeFileSync(path.join(bron, 'package.json'), JSON.stringify({ name: 'app-zes', version: '6.0.0' }));
  git(bron, 'init', '-q', '-b', 'main');
  git(bron, 'config', 'user.email', 'test@example.com');
  git(bron, 'config', 'user.name', 'Test');
  git(bron, 'add', '.');
  git(bron, 'commit', '-q', '-m', 'eerste');
  git(bron, 'remote', 'add', 'origin', bare);
  git(bron, 'push', '-q', 'origin', 'main');
  const app = path.join(TMP, 'app-zes');
  git(TMP, 'clone', '-q', bare, app);
  fs.writeFileSync(path.join(bron, 'package.json'), JSON.stringify({ name: 'app-zes', version: '6.1.0' }));
  git(bron, 'add', '.');
  git(bron, 'commit', '-q', '-m', 'tweede');
  git(bron, 'push', '-q', 'origin', 'main');
  const uit = eigenapps.werkBij(app, 'main', '');
  assert.notEqual(uit.na, uit.voor);
  assert.equal(eigenapps.versie(app), '6.1.0');
});

test('API: app toevoegen, tonen en verwijderen', async () => {
  const pad = maakApp('app-zeven', '7.0.0');
  const toe = await vraag('/api/eigenapps', { method: 'POST', lichaam: { pad } });
  assert.equal(toe.status, 201);
  const toeData = await toe.json();
  assert.equal(toeData.app.versie, '7.0.0');
  assert.equal(toeData.app.pad, pad);
  const lijst = await (await vraag('/api/eigenapps')).json();
  assert.ok(lijst.apps.some((a) => a.pad === pad));
  const weg = await vraag('/api/eigenapps/' + toeData.app.id, { method: 'DELETE' });
  assert.equal(weg.status, 200);
  const na = await (await vraag('/api/eigenapps')).json();
  assert.ok(!na.apps.some((a) => a.pad === pad));
});

test('API: map buiten de eigen map wordt geweigerd', async () => {
  const r = await vraag('/api/eigenapps', { method: 'POST', lichaam: { pad: '/etc' } });
  assert.equal(r.status, 400);
});

test('API: kandidaten toont de gevonden apps', async () => {
  const pad = maakApp('app-acht', '8.0.0');
  const r = await (await vraag('/api/eigenapps/kandidaten')).json();
  assert.ok((r.kandidaten || []).some((k) => k.pad === pad));
});

test('API: bijwerken weigert een niet-schone map', async () => {
  const pad = maakApp('app-negen', '9.0.0');
  fs.writeFileSync(path.join(pad, 'extra.txt'), 'x');
  const toe = await (await vraag('/api/eigenapps', { method: 'POST', lichaam: { pad } })).json();
  const r = await (await vraag('/api/eigenapps/uitvoeren', { method: 'POST', lichaam: { id: toe.app.id } })).json();
  assert.equal(r.uitslag[0].ok, false);
  assert.match(r.uitslag[0].fout, /wijzigingen/);
});
