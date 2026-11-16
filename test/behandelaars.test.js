'use strict';
// Tests voor de behandelaren-lijst: toevoegen, verwijderen, en dat een ticket
// alleen aan een bestaande behandelaar toegewezen kan worden. De lijst staat in
// de instellingen-tabel, dus een herstart mag hem niet wissen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-behandelaars-'));
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.ADMIN_PASSWORD = 'testwachtwoord123';
process.env.GITHUB_TOKEN = '';
process.env.PORT = '0';
process.env.PUBLIEK_POORT = '0';

const { server, db } = require('../server');

let basis;
let koek = '';

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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = 'http://127.0.0.1:' + server.address().port;
  const inlog = await alsJson('/api/login', { method: 'POST', lichaam: { wachtwoord: 'testwachtwoord123' } });
  assert.equal(inlog.status, 200);
  koek = inlog.koppen.get('set-cookie').split(';')[0];
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('de standaardlijst heeft Tom en Werdens Media', async () => {
  const r = await alsJson('/api/behandelaars');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.behandelaars, ['Tom', 'Werdens Media']);
});

test('een behandelaar toevoegen zet hem in de lijst', async () => {
  const r = await alsJson('/api/behandelaars', { method: 'POST', lichaam: { naam: 'Kevin' } });
  assert.equal(r.status, 201);
  assert.ok(r.data.behandelaars.includes('Kevin'));
  const lijst = await alsJson('/api/behandelaars');
  assert.ok(lijst.data.behandelaars.includes('Kevin'), 'blijft bewaard');
});

test('twee keer dezelfde naam wordt geweigerd, ook met andere hoofdletters', async () => {
  const r = await alsJson('/api/behandelaars', { method: 'POST', lichaam: { naam: 'kevin' } });
  assert.equal(r.status, 409);
});

test('een lege naam wordt geweigerd', async () => {
  const r = await alsJson('/api/behandelaars', { method: 'POST', lichaam: { naam: '   ' } });
  assert.equal(r.status, 400);
});

test('een ticket toewijzen aan een nieuwe behandelaar werkt', async () => {
  const r = await alsJson('/api/tickets', {
    method: 'POST',
    lichaam: { titel: 'Printer doet het niet', behandelaar: 'Kevin', prioriteit: 'normaal' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.ticket.behandelaar, 'Kevin');
});

test('een ticket toewijzen aan een onbekende behandelaar wordt geweigerd', async () => {
  const r = await alsJson('/api/tickets', {
    method: 'POST',
    lichaam: { titel: 'Test', behandelaar: 'Niemand' },
  });
  // Bij aanmaken wordt een onbekende naam stil naar leeg gezet; bij wijzigen is
  // het een harde fout. Beide zijn goed, als er maar geen onbekende naam komt.
  assert.equal(r.status, 201);
  assert.equal(r.data.ticket.behandelaar, '');
});

test('wijzigen naar een onbekende behandelaar geeft een fout', async () => {
  const aan = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Wijzigen' } });
  const id = aan.data.ticket.id;
  const r = await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { behandelaar: 'Niemand' } });
  assert.equal(r.status, 400);
});

test('behandelaars staan ook in de instellingen en in de ticketlijst', async () => {
  const inst = await alsJson('/api/instellingen');
  assert.ok(inst.data.behandelaars.includes('Kevin'));
  const lijst = await alsJson('/api/tickets');
  assert.ok(lijst.data.behandelaars.includes('Kevin'));
});

test('verwijderen haalt hem uit de lijst en meldt open tickets', async () => {
  const r = await alsJson('/api/behandelaars', { method: 'DELETE', lichaam: { naam: 'Kevin' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.verwijderd, 'Kevin');
  assert.ok(r.data.open_tickets >= 1, 'telt de open tickets op zijn naam');
  const lijst = await alsJson('/api/behandelaars');
  assert.ok(!lijst.data.behandelaars.includes('Kevin'));
});

test('de laatste behandelaar kan niet verwijderd worden', async () => {
  await alsJson('/api/behandelaars', { method: 'DELETE', lichaam: { naam: 'Werdens Media' } });
  const r = await alsJson('/api/behandelaars', { method: 'DELETE', lichaam: { naam: 'Tom' } });
  assert.equal(r.status, 400);
  const lijst = await alsJson('/api/behandelaars');
  assert.deepEqual(lijst.data.behandelaars, ['Tom']);
});

test('de lijst overleeft een herstart (uit de database)', async () => {
  const opgeslagen = db.prepare("SELECT waarde FROM instellingen WHERE sleutel='behandelaars'").get();
  assert.ok(opgeslagen && opgeslagen.waarde.includes('Tom'));
});
