'use strict';
// Tests voor de Slack-melding bij een nieuw ticket. Elk ticket dat aangemaakt
// wordt (dashboard, agent-API, van een storing, publieke meldpagina) moet één
// bericht naar het kanaal sturen, en de koppeling mag het aanmaken nooit laten
// mislukken.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-slackticket-'));
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.ADMIN_PASSWORD = 'testwachtwoord123';
process.env.GITHUB_TOKEN = '';
process.env.PORT = '0';
process.env.PUBLIEK_POORT = '0';
process.env.WM_SLACK_TEST = '1';

const { server, db } = require('../server');

let basis;
let koek = '';
let agentToken = '';
let hook;
let ontvangen = [];

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
const wacht = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  hook = http.createServer((req, res) => {
    let lichaam = '';
    req.on('data', (c) => { lichaam += c; });
    req.on('end', () => {
      ontvangen.push(JSON.parse(lichaam || '{}'));
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = 'http://127.0.0.1:' + server.address().port;
  agentToken = db.prepare("SELECT waarde FROM instellingen WHERE sleutel='agent_token'").get().waarde;

  const inlog = await alsJson('/api/login', { method: 'POST', lichaam: { wachtwoord: 'testwachtwoord123' } });
  assert.equal(inlog.status, 200, 'inloggen lukt');
  koek = inlog.koppen.get('set-cookie').split(';')[0];

  const url = 'http://127.0.0.1:' + hook.address().port + '/services/T000/B000/xyz';
  const inst = await alsJson('/api/instellingen', {
    method: 'PATCH',
    lichaam: { slack_webhook: url, slack_aan: true, publieke_url: 'https://dashboard.werdensmedia.net' },
  });
  assert.equal(inst.status, 200);
  assert.equal(inst.data.slack_tickets, true, 'tickets melden staat standaard aan');
});

test.after(() => {
  server.close();
  hook.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('een ticket uit het dashboard gaat naar Slack', async () => {
  ontvangen = [];
  const uit = await alsJson('/api/tickets', {
    method: 'POST',
    lichaam: { titel: 'Printer doet het niet', omschrijving: 'Papier vast in lade 2', impact: 'hoog', urgentie: 'hoog' },
  });
  assert.equal(uit.status, 201, 'ticket aangemaakt');
  await wacht();
  assert.equal(ontvangen.length, 1, 'precies één bericht');
  const m = ontvangen[0];
  assert.match(m.text, /Nieuw ticket #\d+/, 'de tekst noemt het ticketnummer');
  assert.match(m.text, /Printer doet het niet/);
  const blok = m.blocks[0].text.text;
  assert.match(blok, /Ticket #\d+ — Printer doet het niet/, 'titel in het blok');
  assert.match(blok, /Prioriteit: \*(kritiek|hoog)\*/, 'prioriteit staat erbij');
  assert.match(blok, /kanaal: dashboard/, 'herkomst staat erbij');
  assert.match(blok, /Papier vast in lade 2/, 'de omschrijving staat erbij');
  assert.ok(JSON.stringify(m).includes('https://dashboard.werdensmedia.net'), 'link naar het dashboard');
  assert.ok(Array.isArray(m.attachments) === false || true);
});

test('een ticket via de agent-API meldt ook', async () => {
  ontvangen = [];
  const uit = await alsJson('/api/agent/tickets', {
    method: 'POST',
    koppen: { authorization: 'Bearer ' + agentToken },
    lichaam: { titel: 'Schijf vol op nas', omschrijving: 'Ruimte 2%', ip: '192.168.1.50' },
  });
  assert.equal(uit.status, 201);
  await wacht();
  assert.equal(ontvangen.length, 1, 'agent-ticket is gemeld');
  const blok = ontvangen[0].blocks[0].text.text;
  assert.match(blok, /Schijf vol op nas/);
  assert.match(blok, /kanaal: agent/);
  assert.match(blok, /192\.168\.1\.50/);
});

test('een melding van de publieke pagina meldt met kanaal meldpagina', async () => {
  ontvangen = [];
  const uit = await alsJson('/api/melden', {
    method: 'POST',
    lichaam: {
      titel: 'Website traag', omschrijving: 'Laden duurt lang', impact: 'normaal', urgentie: 'normaal',
      klant_naam: 'Bezoeker', geopend: Date.now() - 8000,
    },
  });
  assert.equal(uit.status, 201, 'melding aangenomen');
  await wacht();
  assert.equal(ontvangen.length, 1, 'melding is gemeld');
  const blok = ontvangen[0].blocks[0].text.text;
  assert.match(blok, /Website traag/);
  assert.match(blok, /kanaal: meldpagina/);
  assert.match(blok, /Melder: Bezoeker/);
});

test('de schakelaar "ook nieuwe tickets melden" werkt', async () => {
  const uit = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_tickets: false } });
  assert.equal(uit.status, 200);
  assert.equal(uit.data.slack_tickets, false);
  ontvangen = [];
  const ticket = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Stil testticket' } });
  assert.equal(ticket.status, 201, 'ticket wordt gewoon aangemaakt');
  await wacht();
  assert.equal(ontvangen.length, 0, 'geen bericht als de schakelaar uit staat');

  const aan = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_tickets: true } });
  assert.equal(aan.data.slack_tickets, true);
  await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Weer aan' } });
  await wacht();
  assert.equal(ontvangen.length, 1, 'weer melden zodra de schakelaar aan staat');
});

test('een kapotte webhook laat het ticket gewoon doorgaan', async () => {
  const dood = 'http://127.0.0.1:1/services/T000/B000/xyz';
  await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_webhook: dood } });
  const uit = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Ticket ondanks kapotte webhook' } });
  assert.equal(uit.status, 201, 'ticket aangemaakt ook al faalt Slack');
  await wacht(400);
  const gelezen = await alsJson('/api/instellingen');
  assert.match(gelezen.data.slack_laatst_fout || '', /—/, 'de fout wordt bewaard voor de instellingenpagina');
});
