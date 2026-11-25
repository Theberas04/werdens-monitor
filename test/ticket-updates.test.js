'use strict';
// Tests voor het melden van een update aan een ticket: één Slack-bericht naar
// het kanaal, en (als er een mailserver is ingesteld en er staat een adres op
// het ticket) één e-mail aan de melder. Een kapotte webhook of mailserver mag
// het bijwerken van een ticket nooit laten mislukken.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-updates-'));
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.ADMIN_PASSWORD = 'testwachtwoord123';
process.env.GITHUB_TOKEN = '';
process.env.PORT = '0';
process.env.PUBLIEK_POORT = '0';
process.env.WM_SLACK_TEST = '1';
process.env.MAIL_TIMEOUT_MS = '4000';

const { server, db } = require('../server');
const mail = require('../lib/mail');

let basis;
let koek = '';
let slackOntvangen = [];
let mailsOntvangen = [];
let mailserver;
let hook;
let mailPoort;
let mailModus = 'ok';

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
const wacht = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// Het tekstdeel van een bericht zit base64 in de MIME: decodeer het zodat een
// test op de inhoud kan letten in plaats van op de codering.
// De monitor draait ook meetrondes die zelf meldingen kunnen sturen; voor deze
// tests tellen alleen de berichten die over een ticket gaan.
function ticketBerichten() {
  return slackOntvangen.filter((b) => JSON.stringify(b).includes('Ticket #'));
}

function leesbaar(ruw) {
  const delen = String(ruw).split(/--wm-[a-z0-9-]+/);
  for (const deel of delen) {
    if (!/text\/plain/.test(deel)) continue;
    const na = deel.split(/\r\n\r\n/).slice(1).join('\r\n\r\n');
    if (!na) continue;
    try { return Buffer.from(na.replace(/\r\n/g, ''), 'base64').toString('utf8'); } catch { return na; }
  }
  return ruw;
}

// Een minimale SMTP-server: genoeg om het gesprek van lib/mail.js af te lopen
// en de DATA te bewaren, zodat een test ziet wat er echt verstuurd is.
function maakMailserver() {
  return net.createServer((socket) => {
    let data = '';
    let inData = false;
    let envelop = { van: '', naar: '' };
    socket.write('220 test-smtp klaar\r\n');
    socket.on('data', (chunk) => {
      const stuk = chunk.toString('utf8');
      if (inData) {
        data += stuk;
        // Het bericht eindigt met een regel die alleen '.' is.
        const einde = data.indexOf('\r\n.\r\n');
        if (einde >= 0) {
          const ruw = data.slice(0, einde);
          mailsOntvangen.push({ ...envelop, ruw, kop: ruw.split('\r\n').slice(0, 8).join('\n') });
          inData = false;
          data = '';
          socket.write('250 2.0.0 ok: bericht aangenomen\r\n');
        }
        return;
      }
      for (const regel of stuk.split('\r\n').filter(Boolean)) {
        const g = regel.trim();
        if (/^EHLO|^HELO/i.test(g)) socket.write('250-test-smtp\r\n250-AUTH LOGIN PLAIN\r\n250 STARTTLS\r\n');
        else if (/^AUTH LOGIN/i.test(g)) socket.write('334 VXNlcm5hbWU6\r\n');
        else if (/^[A-Za-z0-9+/=]{8,}$/.test(g)) socket.write('334 UGFzc3dvcmQ6\r\n');
        else if (/^MAIL FROM:<([^>]*)>/i.test(g)) { envelop.van = RegExp.$1; socket.write('250 ok\r\n'); }
        else if (/^RCPT TO:<([^>]*)>/i.test(g)) { envelop.naar = RegExp.$1; socket.write('250 ok\r\n'); }
        else if (/^DATA/i.test(g)) { inData = true; socket.write('354 ga je gang\r\n'); }
        else if (/^QUIT/i.test(g)) { socket.write('221 tot ziens\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
}

test.before(async () => {
  hook = http.createServer((req, res) => {
    let lichaam = '';
    req.on('data', (c) => { lichaam += c; });
    req.on('end', () => {
      slackOntvangen.push(JSON.parse(lichaam || '{}'));
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));

  mailserver = maakMailserver();
  await new Promise((r) => mailserver.listen(0, '127.0.0.1', r));
  mailPoort = mailserver.address().port;

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = 'http://127.0.0.1:' + server.address().port;

  const inlog = await alsJson('/api/login', { method: 'POST', lichaam: { wachtwoord: 'testwachtwoord123' } });
  assert.equal(inlog.status, 200);
  koek = inlog.koppen.get('set-cookie').split(';')[0];

  const inst = await alsJson('/api/instellingen', {
    method: 'PATCH',
    lichaam: {
      slack_webhook: 'http://127.0.0.1:' + hook.address().port + '/services/T000/B000/xyz',
      slack_aan: true, publieke_url: 'https://dashboard.werdensmedia.net',
      mail_aan: true, mail_host: '127.0.0.1', mail_poort: String(mailPoort), mail_beveiliging: 'geen',
      mail_van: 'monitor@werdensmedia.nl', mail_van_naam: 'Werdens Monitor',
    },
  });
  assert.equal(inst.status, 200, JSON.stringify(inst.data));
});

test.after(() => {
  server.close();
  hook.close();
  mailserver.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Het mailbericht zelf ────────────────────────────────────────────────────
test('het bericht voor een update noemt het ticket, de wijziging en de link', () => {
  const b = mail.berichtVoorTicketUpdate(
    { id: 7, titel: 'Switch poort 12 stuk', status: 'in behandeling', prioriteit: 'hoog', behandelaar: 'Tom' },
    { wijziging: 'status: in behandeling', basis: 'https://dashboard.werdensmedia.net' });
  assert.match(b.onderwerp, /Ticket #7/);
  assert.match(b.onderwerp, /Switch poort 12 stuk/);
  assert.match(b.tekst, /status: in behandeling/);
  assert.match(b.tekst, /dashboard\.werdensmedia\.net/);
  assert.match(b.tekst, /automatisch verstuurd/);
});

test('de instellingencontrole eist host, poort, afzender en wachtwoord', () => {
  assert.throws(() => mail.controleerInstellingen({}), /mailserver/i);
  assert.throws(() => mail.controleerInstellingen({ host: 'smtp.x.nl' }), /afzenderadres/i);
  assert.throws(() => mail.controleerInstellingen({ host: 'smtp.x.nl', van: 'fout' }), /afzenderadres/i);
  assert.throws(() => mail.controleerInstellingen({ host: 'smtp.x.nl', van: 'a@b.nl', gebruiker: 'u' }), /wachtwoord/i);
  const c = mail.controleerInstellingen({ host: 'smtp.x.nl', van: 'a@b.nl' });
  assert.equal(c.beveiliging, 'starttls');
  assert.equal(c.poort, 587);
});

// ── Slack bij een update ────────────────────────────────────────────────────
test('een statuswijziging op een ticket gaat naar Slack', async () => {
  const gemaakt = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Testupdate', ip: '10.0.0.5' } });
  assert.equal(gemaakt.status, 201);
  const id = gemaakt.data.ticket.id;
  await wacht();
  slackOntvangen = [];

  const bij = await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { status: 'in behandeling' } });
  assert.equal(bij.status, 200);
  await wacht();

  assert.equal(ticketBerichten().length, 1, 'precies één Slack-bericht bij de wijziging');
  const tekst = JSON.stringify(ticketBerichten()[0]);
  assert.match(tekst, /bijgewerkt/i);
  assert.match(tekst, /in behandeling/);
});

test('opnieuw opslaan zonder wijziging stuurt geen bericht', async () => {
  const gemaakt = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Geen wijziging' } });
  const id = gemaakt.data.ticket.id;
  await wacht();
  slackOntvangen = [];
  // Het formulier stuurt alle velden mee; dezelfde waarden horen stil te zijn.
  const t = gemaakt.data.ticket;
  const r = await alsJson('/api/tickets/' + id, {
    method: 'PATCH',
    lichaam: { status: t.status, prioriteit: t.prioriteit, titel: t.titel, categorie: t.categorie || '' },
  });
  assert.equal(r.status, 200);
  await wacht();
  assert.equal(ticketBerichten().length, 0, 'geen bericht bij een lege wijziging');
});

test('een nieuw bericht op een ticket meldt met de tekst erbij', async () => {
  const gemaakt = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Met gesprek' } });
  const id = gemaakt.data.ticket.id;
  await wacht();
  slackOntvangen = [];

  const r = await alsJson('/api/tickets/' + id + '/berichten', { method: 'POST', lichaam: { bericht: 'Ik kijk er nu naar' } });
  assert.equal(r.status, 201);
  await wacht();

  assert.equal(slackOntvangen.length, 1);
  const tekst = JSON.stringify(ticketBerichten()[0]);
  assert.match(tekst, /Nieuw bericht/);
  assert.match(tekst, /Ik kijk er nu naar/);
});

test('de schakelaar "ook updates melden" zet het uit', async () => {
  const gemaakt = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Stille update' } });
  const id = gemaakt.data.ticket.id;
  await wacht();
  await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_updates: false } });
  slackOntvangen = [];
  await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { prioriteit: 'hoog' } });
  await wacht();
  assert.equal(ticketBerichten().length, 0, 'geen bericht als de schakelaar uit staat');

  await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_updates: true } });
  await wacht();
  slackOntvangen = [];
  await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { prioriteit: 'kritiek' } });
  await wacht();
  assert.equal(ticketBerichten().length, 1, 'weer melden als hij aan staat');
});

// ── E-mail aan de melder ────────────────────────────────────────────────────
test('een update mailt naar het adres dat op het ticket staat', async () => {
  const gemaakt = await alsJson('/api/tickets', {
    method: 'POST', lichaam: { titel: 'Met melder', klant_email: 'melder@voorbeeld.nl' },
  });
  const id = gemaakt.data.ticket.id;
  await wacht();
  mailsOntvangen = [];
  slackOntvangen = [];

  await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { status: 'opgelost', oplossing: 'Kabel vervangen' } });
  await wacht(700);

  assert.equal(mailsOntvangen.length, 1, 'één e-mail aan de melder');
  assert.equal(mailsOntvangen[0].naar, 'melder@voorbeeld.nl');
  assert.equal(mailsOntvangen[0].van, 'monitor@werdensmedia.nl');
  assert.match(leesbaar(mailsOntvangen[0].ruw), /Ticket #/);
  assert.equal(ticketBerichten().length, 1, 'dezelfde update gaat ook naar Slack');
});

test('zonder e-mailadres op het ticket gaat er niets de deur uit', async () => {
  const gemaakt = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Zonder adres' } });
  mailsOntvangen = [];
  await alsJson('/api/tickets/' + gemaakt.data.ticket.id, { method: 'PATCH', lichaam: { status: 'in behandeling' } });
  await wacht(500);
  assert.equal(mailsOntvangen.length, 0);
});

test('een nieuwe melding via de publieke pagina mailt niet, maar meldt wel op Slack', async () => {
  slackOntvangen = [];
  mailsOntvangen = [];
  const r = await alsJson('/api/melden', {
    method: 'POST',
    lichaam: {
      titel: 'Printer stuk', omschrijving: 'Doet niets meer', klant_naam: 'Kevin',
      klant_email: 'kevin@voorbeeld.nl', geopend: Date.now() - 5000,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await wacht(500);
  assert.equal(ticketBerichten().length, 1, 'het nieuwe ticket wordt gemeld');
  assert.equal(mailsOntvangen.length, 0, 'bij het aanmaken nog geen mail');
});

test('een kapotte mailserver laat het bijwerken van een ticket doorgaan', async () => {
  const gemaakt = await alsJson('/api/tickets', {
    method: 'POST', lichaam: { titel: 'Mail stuk', klant_email: 'melder@voorbeeld.nl' },
  });
  // Wijs de mail naar een dichte poort: verbinden mislukt.
  await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { mail_poort: '9', mail_host: '127.0.0.1' } });

  const bij = await alsJson('/api/tickets/' + gemaakt.data.ticket.id, { method: 'PATCH', lichaam: { status: 'in behandeling' } });
  assert.equal(bij.status, 200, 'de wijziging lukt gewoon');
  await wacht(1500);

  const inst = await alsJson('/api/instellingen');
  assert.match(String(inst.data.mail_laatst_fout), /lukte niet|reageerde niet/i, 'de fout staat zichtbaar in de instellingen');

  // Terug naar de goede server voor de volgende test.
  await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { mail_host: '127.0.0.1', mail_poort: String(mailPoort), mail_beveiliging: 'geen' } });
});

// ── Het testbericht ─────────────────────────────────────────────────────────
test('het testbericht verstuurt echt (en eist een adres)', async () => {
  mailsOntvangen = [];
  const leeg = await alsJson('/api/mail/test', { method: 'POST', lichaam: {} });
  assert.equal(leeg.status, 400);

  const r = await alsJson('/api/mail/test', { method: 'POST', lichaam: { naar: 'ik@voorbeeld.nl' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await wacht(400);
  assert.equal(mailsOntvangen.length, 1);
  assert.equal(mailsOntvangen[0].naar, 'ik@voorbeeld.nl');
  assert.match(leesbaar(mailsOntvangen[0].ruw), /testbericht/i);
});

test('het wachtwoord komt nooit in een antwoord terug', async () => {
  await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { mail_wachtwoord: 'geheim123' } });
  const inst = await alsJson('/api/instellingen');
  const alles = JSON.stringify(inst.data);
  assert.equal(alles.includes('geheim123'), false, 'het wachtwoord staat niet in het antwoord');
  assert.equal(inst.data.mail_wachtwoord_ingesteld, true, 'wel dat er een is ingesteld');
});
