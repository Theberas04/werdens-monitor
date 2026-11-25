'use strict';
// Eigen SMTP-client voor Werdens Monitor — geen npm-pakket, alleen node:net en
// node:tls. Het dashboard stuurt hiermee een bericht naar de melder van een
// ticket zodra er iets in dat ticket verandert. De aanroeper bepaalt wanneer;
// dit bestand doet één gesprek: verbinden, EHLO, STARTTLS of meteen TLS,
// inloggen (AUTH LOGIN), MAIL FROM / RCPT TO / DATA, en dan netjes QUIT.
//
// Een time-out en een korte foutmelding houden een trage of kapotte mailserver
// buiten het dashboard: de aanroeper vangt de fout op en gaat verder, net als
// bij de Slack-webhook.

const net = require('node:net');
const tls = require('node:tls');

const TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS) || 12000;
const SOORTEN = ['geen', 'starttls', 'tls'];
const ADRES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const schoon = (v, max = 300) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// ── Het gesprek ─────────────────────────────────────────────────────────────
// Een klein lezertje dat per antwoord de regels verzamelt. Een SMTP-antwoord is
// klaar bij een regel `NNN ` (code, spatie): meerregelige antwoorden gebruiken
// `NNN-` voor de tussenregels.
function maakSessie(socket) {
  let buffer = '';
  let verzameld = [];
  const wachters = [];

  const lever = () => {
    while (wachters.length && verzameld.some((r) => /^\d{3} /.test(r))) {
      const w = wachters.shift();
      const uit = verzameld;
      verzameld = [];
      w.oplossen(uit);
    }
  };
  const mis = (e) => {
    const fout = e instanceof Error ? e : new Error(String(e));
    while (wachters.length) wachters.shift().afwijzen(fout);
  };

  socket.on('data', (c) => {
    buffer += c.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      verzameld.push(buffer.slice(0, i).replace(/\r$/, ''));
      buffer = buffer.slice(i + 1);
    }
    lever();
  });
  socket.on('error', mis);
  socket.on('close', () => mis(new Error('de mailserver sloot de verbinding')));
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('de mailserver reageerde niet binnen ' + Math.round(TIMEOUT_MS / 1000) + ' seconden')));

  return {
    hoor: () => new Promise((oplossen, afwijzen) => { wachters.push({ oplossen, afwijzen }); lever(); }),
    stuur: (tekst) => socket.write(tekst + '\r\n'),
    klaar: () => { try { socket.end(); } catch { /* al dicht */ } },
  };
}

const code = (regels) => Number(String(regels[regels.length - 1] || '').slice(0, 3));

// Wacht op een antwoord en eist een van de toegestane codes; anders een fout met
// de tekst van de server erbij, zodat een verkeerd wachtwoord leesbaar is.
async function verwacht(sessie, toegestaan, wat) {
  const regels = await sessie.hoor();
  if (!toegestaan.includes(code(regels))) {
    const laatste = String(regels[regels.length - 1] || '').slice(4);
    throw new Error(wat + ': ' + (laatste || 'onbekend antwoord') + ' (' + code(regels) + ')');
  }
  return regels;
}

function verbind(host, poort, beveiliging) {
  return new Promise((oplossen, afwijzen) => {
    const socket = beveiliging === 'tls'
      ? tls.connect({ host, port: poort, servername: host })
      : net.connect({ host, port: poort });
    const klaar = beveiliging === 'tls' ? 'secureConnect' : 'connect';
    const bijFout = (e) => afwijzen(new Error('verbinden met ' + host + ':' + poort + ' lukte niet — ' + e.message));
    socket.once('error', bijFout);
    socket.once(klaar, () => { socket.removeListener('error', bijFout); oplossen(socket); });
  });
}

function upgrade(socket, host) {
  return new Promise((oplossen, afwijzen) => {
    const beveiligd = tls.connect({ socket, servername: host });
    beveiligd.once('secureConnect', () => oplossen(beveiligd));
    beveiligd.once('error', (e) => afwijzen(new Error('STARTTLS mislukte — ' + e.message)));
  });
}

// ── Het bericht ─────────────────────────────────────────────────────────────
const basis64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const omhul = (s) => (basis64(s).match(/.{1,76}/g) || ['']).join('\r\n');

function kop(waarde) {
  // Underwerp met niet-ASCII netjes coderen (RFC 2047), zodat 'bijgewerkt' met
  // accenten niet als rommel aankomt.
  return /^[\x20-\x7e]*$/.test(waarde) ? waarde : '=?UTF-8?B?' + basis64(waarde) + '?=';
}

function bouwBericht({ van, vanNaam, naar, onderwerp, tekst, html }) {
  const grens = 'wm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const afzender = vanNaam ? '"' + vanNaam.replace(/"/g, '') + '" <' + van + '>' : van;
  const kopregels = [
    'From: ' + afzender,
    'To: <' + naar + '>',
    'Subject: ' + kop(schoon(onderwerp, 200)),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 10) + '@werdens-monitor>',
    'MIME-Version: 1.0',
  ];
  if (html) {
    return kopregels.concat([
      'Content-Type: multipart/alternative; boundary="' + grens + '"',
      '',
      '--' + grens,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      omhul(tekst),
      '--' + grens,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      omhul(html),
      '--' + grens + '--',
    ]).join('\r\n');
  }
  return kopregels.concat([
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    omhul(tekst),
  ]).join('\r\n');
}

function ontsnap(html) {
  return String(html).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Controle en verzenden ───────────────────────────────────────────────────
function controleerInstellingen(cfg) {
  const host = schoon(cfg && cfg.host, 200);
  if (!host) throw new Error('Vul de mailserver in (bijvoorbeeld smtp.jouwprovider.nl)');
  const beveiliging = SOORTEN.includes(cfg && cfg.beveiliging) ? cfg.beveiliging : 'starttls';
  const poort = Number(cfg && cfg.poort) || (beveiliging === 'tls' ? 465 : 587);
  if (!(poort > 0 && poort < 65536)) throw new Error('De poort moet tussen 1 en 65535 liggen');
  const van = schoon(cfg && cfg.van, 200);
  if (!ADRES.test(van)) throw new Error('Vul een geldig afzenderadres in');
  const gebruiker = schoon(cfg && cfg.gebruiker, 200);
  const wachtwoord = String((cfg && cfg.wachtwoord) || '');
  if (gebruiker && !wachtwoord) throw new Error('Vul het wachtwoord van de mailserver in');
  return { host, poort, beveiliging, gebruiker, wachtwoord, van, vanNaam: schoon(cfg && cfg.vanNaam, 80) || 'Werdens Monitor' };
}

// Eén gesprek, van verbinden tot QUIT. Gooit een leesbare fout bij een weigering.
async function verzend(cfg, bericht) {
  const c = controleerInstellingen(cfg);
  if (!ADRES.test(schoon(bericht && bericht.naar, 200))) throw new Error('Geen geldig ontvangeradres');

  let socket = await verbind(c.host, c.poort, c.beveiliging);
  let sessie = maakSessie(socket);
  try {
    await verwacht(sessie, [220], 'De mailserver begroette niet');
    sessie.stuur('EHLO werden-monitor');
    await verwacht(sessie, [250], 'EHLO werd geweigerd');

    if (c.beveiliging === 'starttls') {
      sessie.stuur('STARTTLS');
      await verwacht(sessie, [220], 'STARTTLS werd geweigerd');
      socket = await upgrade(socket, c.host);
      sessie = maakSessie(socket);
      sessie.stuur('EHLO werden-monitor');
      await verwacht(sessie, [250], 'EHLO werd geweigerd na STARTTLS');
    }

    if (c.gebruiker) {
      sessie.stuur('AUTH LOGIN');
      await verwacht(sessie, [334], 'Inloggen werd niet geaccepteerd');
      sessie.stuur(basis64(c.gebruiker));
      await verwacht(sessie, [334], 'Inloggen werd niet geaccepteerd');
      sessie.stuur(basis64(c.wachtwoord));
      await verwacht(sessie, [235], 'De mailserver weigerde het wachtwoord');
    }

    sessie.stuur('MAIL FROM:<' + c.van + '>');
    await verwacht(sessie, [250], 'De afzender werd geweigerd');
    sessie.stuur('RCPT TO:<' + schoon(bericht.naar, 200) + '>');
    await verwacht(sessie, [250, 251], 'De ontvanger werd geweigerd');
    sessie.stuur('DATA');
    await verwacht(sessie, [354], 'De mailserver nam geen inhoud aan');
    sessie.stuur(bouwBericht({ ...c, ...bericht }));
    sessie.stuur('.');
    await verwacht(sessie, [250], 'Het bericht werd niet aangenomen');
    sessie.stuur('QUIT');
    return { ok: true };
  } finally {
    sessie.klaar();
    try { socket.destroy(); } catch { /* al dicht */ }
  }
}

// ── Het bericht voor een ticket ─────────────────────────────────────────────
// Kort en zonder jargon: wat er veranderd is, de stand van het ticket en een
// link naar het dashboard. De melder hoeft niet in te loggen om te begrijpen
// waar het over gaat.
function berichtVoorTicketUpdate(ticket, extra = {}) {
  const t = ticket || {};
  const id = String(t.id || '');
  const titel = schoon(t.titel, 160) || 'Ticket #' + id;
  const wijziging = schoon(extra.wijziging, 300);
  const basis = schoon(extra.basis, 300);
  const regelTekst = (k, v) => (v ? k + ': ' + v : '');

  const onderwerp = 'Ticket #' + id + ' bijgewerkt — ' + titel;
  const regels = [
    'Er is iets veranderd aan je ticket bij Werdens Media.',
    '',
    'Ticket #' + id + ': ' + titel,
    wijziging ? 'Wat er veranderd is: ' + wijziging : '',
    regelTekst('Status', schoon(t.status, 40)),
    regelTekst('Prioriteit', schoon(t.prioriteit, 20)),
    regelTekst('Behandelaar', schoon(t.behandelaar, 60)),
    t.oplossing ? 'Oplossing: ' + schoon(t.oplossing, 600) : '',
    '',
    basis ? 'Volgen kan in het dashboard: ' + basis : '',
    '',
    'Dit bericht is automatisch verstuurd door Werdens Monitor.',
  ].filter((r) => r !== '');
  const tekst = regels.join('\n');

  const html = [
    '<p>Er is iets veranderd aan je ticket bij <b>Werdens Media</b>.</p>',
    '<p><b>Ticket #' + ontsnap(id) + '</b>: ' + ontsnap(titel) + '</p>',
    wijziging ? '<p><b>Wat er veranderd is:</b> ' + ontsnap(wijziging) + '</p>' : '',
    '<ul>',
    t.status ? '<li>Status: ' + ontsnap(schoon(t.status, 40)) + '</li>' : '',
    t.prioriteit ? '<li>Prioriteit: ' + ontsnap(schoon(t.prioriteit, 20)) + '</li>' : '',
    t.behandelaar ? '<li>Behandelaar: ' + ontsnap(schoon(t.behandelaar, 60)) + '</li>' : '',
    '</ul>',
    t.oplossing ? '<p><b>Oplossing:</b> ' + ontsnap(schoon(t.oplossing, 600)) + '</p>' : '',
    basis ? '<p><a href="' + ontsnap(basis) + '">Open het dashboard</a></p>' : '',
    '<p style="color:#8a94a6;font-size:12.5px">Dit bericht is automatisch verstuurd door Werdens Monitor.</p>',
  ].filter(Boolean).join('\n');

  return { onderwerp, tekst, html };
}

module.exports = { controleerInstellingen, verzend, berichtVoorTicketUpdate, SOORTEN, ADRES };
