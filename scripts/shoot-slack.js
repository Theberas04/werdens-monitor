'use strict';
// Maakt één schermafbeelding van de Slack-kaart op de instellingenpagina,
// zodat de README precies laat zien waar de webhook hoort.
// Gebruik: BASE=http://127.0.0.1:8099 WACHTWOORD=demo1234 node scripts/shoot-slack.js docs/img/slack-meldingen.png
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const WACHTWOORD = process.env.WACHTWOORD || 'demo1234';
const UIT = path.resolve(process.argv[2] || 'docs/img/slack-meldingen.png');
const CHROOM = process.env.CHROOM || path.join(process.env.HOME, '.hermes/tools/chromium-1208/chrome-linux64/chrome');
const LIB = path.join(process.env.HOME, '.local/chromelibs/root/usr/lib/x86_64-linux-gnu');
const POORT = Number(process.env.CDP_POORT || 9229);
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROOM, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--remote-debugging-port=' + POORT, '--window-size=1440,900', 'about:blank'],
  { env: { ...process.env, LD_LIBRARY_PATH: LIB }, stdio: 'ignore' });

(async () => {
  let wsUrl;
  for (let i = 0; i < 120 && !wsUrl; i++) {
    try {
      const lijst = await (await fetch('http://127.0.0.1:' + POORT + '/json/list')).json();
      const t = lijst.find((x) => x.type === 'page');
      if (t) wsUrl = t.webSocketDebuggerUrl;
    } catch (_) {}
    if (!wsUrl) await wacht(100);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let n = 0; const wachtenden = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wachtenden.has(m.id)) { wachtenden.get(m.id)(m); wachtenden.delete(m.id); }
  });
  const stuur = (method, params = {}) => new Promise((r) => {
    const id = ++n; wachtenden.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expr) => {
    const r = await stuur('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await stuur('Page.enable');
  await stuur('Runtime.enable');
  await stuur('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await stuur('Page.navigate', { url: BASE });
  await wacht(1400);
  await js(`(() => {
    const i = document.querySelector('#loginform input[type=password], #login input');
    if (!i) return false;
    i.value = ${JSON.stringify(WACHTWOORD)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#loginform').requestSubmit();
    return true;
  })()`);
  await wacht(2200);
  await js(`(() => { const b = document.querySelector('nav button[data-tab="instellingen"]'); if (b) b.click(); return true; })()`);
  await wacht(2200);
  const box = await js(`(() => {
    const kop = [...document.querySelectorAll('.kaart-kop h2')].find((h) => h.textContent.includes('Slack-meldingen'));
    if (!kop) return null;
    const kaart = kop.closest('.kaart');
    const r = kaart.getBoundingClientRect();
    return { x: Math.max(0, r.left - 10), y: Math.max(0, r.top - 10), w: r.width + 20, h: r.height + 20 };
  })()`);
  if (!box) throw new Error('Slack-kaart niet gevonden');
  const shot = await stuur('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 },
  });
  fs.mkdirSync(path.dirname(UIT), { recursive: true });
  fs.writeFileSync(UIT, Buffer.from(shot.result.data, 'base64'));
  console.log(UIT, fs.statSync(UIT).size);
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error('fout:', e.message); chrome.kill(); process.exit(1); });
