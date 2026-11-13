'use strict';
// Maakt de schermafbeeldingen voor docs/img. Start Chromium met CDP, logt in,
// loopt de tabs af en schiet per tab een desktop- en een mobiel beeld.
// Gebruik: BASE=http://127.0.0.1:8099 WACHTWOORD=demo1234 node scripts/shoot.js docs/img
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const WACHTWOORD = process.env.WACHTWOORD || 'demo1234';
const UIT = path.resolve(process.argv[2] || 'docs/img');
const CHROOM = process.env.CHROOM || path.join(process.env.HOME, '.hermes/tools/chromium-1208/chrome-linux64/chrome');
const LIB = path.join(process.env.HOME, '.local/chromelibs/root/usr/lib/x86_64-linux-gnu');
const POORT = Number(process.env.CDP_POORT || 9223);

const TABS = [
  ['overzicht', 'Overzicht'],
  ['projecten', 'Projecten'],
  ['websites', 'Websites'],
  ['hosts', 'IP-adressen'],
  ['servers', 'Servers'],
  ['apparaten', 'Apparaten'],
  ['software', 'Software'],
  ['tickets', 'Tickets'],
  ['instellingen', 'Instellingen'],
];

fs.mkdirSync(UIT, { recursive: true });
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROOM, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', `--remote-debugging-port=${POORT}`,
  '--window-size=1440,900', 'about:blank',
], { env: { ...process.env, LD_LIBRARY_PATH: LIB }, stdio: ['ignore', 'ignore', 'pipe'] });

async function doel() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${POORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page');
      if (t) return t.webSocketDebuggerUrl;
    } catch (_) {}
    await wacht(100);
  }
  throw new Error('Chrome kwam niet op');
}

(async () => {
  const url = await doel();
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let n = 0;
  const wachtenden = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wachtenden.has(m.id)) { wachtenden.get(m.id)(m); wachtenden.delete(m.id); }
  };
  const stuur = (method, params = {}) => new Promise((r) => {
    const id = ++n; wachtenden.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  const eval_ = async (expr) => {
    const r = await stuur('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await stuur('Page.enable');
  await stuur('Runtime.enable');
  await stuur('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await stuur('Page.navigate', { url: BASE });
  await wacht(1400);
  // verse pagina: service worker en cache mogen nooit een oude versie tonen
  await eval_(`(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    return true;
  })()`);
  await stuur('Page.reload', { ignoreCache: true });
  await wacht(1500);

  const ingelogd = await eval_(`(() => {
    const i = document.querySelector('#loginform input[type=password], #login input');
    if (!i) return false;
    i.value = ${JSON.stringify(WACHTWOORD)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#loginform').requestSubmit();
    return true;
  })()`);
  await wacht(ingelogd ? 2600 : 800);

  const schiet = async (naam) => {
    const r = await stuur('Page.captureScreenshot', { format: 'png' });
    const b = Buffer.from(r.result.data, 'base64');
    fs.writeFileSync(path.join(UIT, naam), b);
    console.log(naam, b.length);
  };

  for (const [id, naam] of TABS) {
    await eval_(`(() => { const b = document.querySelector('nav.tabs button[data-tab="${id}"]'); if (b) { b.click(); return true; } return false; })()`);
    await wacht(1900);
    await schiet(`${id}-desktop.png`);
  }

  // TopDesk-laag: de drie weergaven onder Tickets en het detail van een ticket.
  const subTab = async (sleutel) => {
    await eval_(`(() => { const b = document.querySelector('nav.tabs button[data-tab="tickets"]'); if (b) b.click(); return true; })()`);
    await wacht(1500);
    await eval_(`(() => { const b = document.querySelector('#ticket-seg [data-tseg="${sleutel}"]'); if (b) { b.click(); return true; } return false; })()`);
    await wacht(1800);
  };
  await subTab('rapport');
  await schiet('rapportage-desktop.png');
  await subTab('kennisbank');
  await schiet('kennisbank-desktop.png');
  await subTab('tickets');
  await eval_(`(() => { const t = document.querySelector('.ticket-rij'); if (t) { t.click(); return true; } return false; })()`);
  await wacht(1900);
  await schiet('ticket-detail-desktop.png');

  // detail van de eerste host, zodat het IP-scherm ook gedocumenteerd is
  await eval_(`(() => { const b = document.querySelector('nav.tabs button[data-tab="hosts"]'); if (b) b.click(); return true; })()`);
  await wacht(1600);
  await eval_(`(() => { const h = document.querySelector('.host'); if (h) { h.click(); return true; } return false; })()`);
  await wacht(1800);
  await schiet('host-detail-desktop.png');
  await eval_(`(() => { const b = document.querySelector('[data-terug]'); if (b) b.click(); return true; })()`);
  await wacht(1500);

  // detail van de eerste server, zodat de hardwarepagina gedocumenteerd is
  await eval_(`(() => { const b = document.querySelector('nav.tabs button[data-tab="servers"]'); if (b) b.click(); return true; })()`);
  await wacht(1600);
  await eval_(`(() => { const s = document.querySelector('[data-server]'); if (s) { s.click(); return true; } return false; })()`);
  await wacht(1800);
  await schiet('server-detail-desktop.png');
  await eval_(`(() => { const b = document.querySelector('[data-terug]'); if (b) { b.click(); return true; } return false; })()`);
  await wacht(1200);

  // mobiel: 412×915 (Pixel-formaat), daarna elke tab
  await stuur('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await wacht(1200);
  for (const [id] of TABS) {
    await eval_(`(() => { const b = document.querySelector('nav.tabs button[data-tab="${id}"]'); if (b) { b.click(); return true; } return false; })()`);
    await wacht(1500);
    await schiet(`${id}-mobiel.png`);
  }

  // Mobiel: rapportage, kennisbank en het ticketdetail.
  for (const [sleutel, naam] of [['rapport', 'rapportage-mobiel.png'], ['kennisbank', 'kennisbank-mobiel.png']]) {
    await subTab(sleutel);
    await schiet(naam);
  }
  await subTab('tickets');
  await eval_(`(() => { const t = document.querySelector('.ticket-rij'); if (t) { t.click(); return true; } return false; })()`);
  await wacht(1800);
  await schiet('ticket-detail-mobiel.png');

  // De publieke meldpagina hoort zonder sessie te werken; eerst uitloggen.
  await eval_(`(async () => { await fetch('/api/logout', { method: 'POST' }); return true; })()`);
  await stuur('Page.navigate', { url: BASE + '/melden' });
  await wacht(1800);
  await schiet('melden-mobiel.png');
  await stuur('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wacht(900);
  await schiet('melden-desktop.png');

  // controle: niets mag horizontaal overlopen
  const overloop = await eval_(`(() => {
    const w = window.innerWidth;
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: w,
      teBreed: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1)
        .slice(0, 8).map((e) => e.tagName + '.' + (e.className || '').toString().slice(0, 40)) };
  })()`);
  console.log('overloop:', JSON.stringify(overloop));

  ws.close();
  chrome.kill('SIGKILL');
  process.exit(0);
})().catch((e) => {
  console.error('fout:', e.message);
  try { chrome.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
