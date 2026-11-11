'use strict';
// Neemt de app op via CDP: een loop van Page.captureScreenshot (jpeg) met
// tijdstempels, terwijl een script de interface bedient. scripts/make-video.sh
// zet de frames om in een MP4 met de echte timing.
// Gebruik: BASE=http://127.0.0.1:8099 node scripts/record-demo.js uit/frames
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const OUT = path.resolve(process.argv[2] || 'uit/frames');
const CHROOM = process.env.CHROOM || path.join(process.env.HOME, '.hermes/tools/chromium-1208/chrome-linux64/chrome');
const LIB = path.join(process.env.HOME, '.local/chromelibs/root/usr/lib/x86_64-linux-gnu');
const POORT = Number(process.env.CDP_POORT || 9222);
const W = 1440, H = 900;
const FRAME_MS = Number(process.env.FRAME_MS || 95);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROOM, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', `--remote-debugging-port=${POORT}`,
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', 'about:blank',
], { env: { ...process.env, LD_LIBRARY_PATH: LIB }, stdio: ['ignore', 'ignore', 'pipe'] });

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

async function haalDoel() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${POORT}/json/list`);
      const lijst = await r.json();
      const pagina = lijst.find((t) => t.type === 'page');
      if (pagina) return pagina.webSocketDebuggerUrl;
    } catch (_) {}
    await wacht(100);
  }
  throw new Error('Chrome kwam niet op');
}

(async () => {
  const wsUrl = await haalDoel();
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const wachtOp = new Map();
  const frames = [];
  let laatste = Date.now();
  let stoppen = false;
  let loopKlaar = false;

  const stuur = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    wachtOp.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && wachtOp.has(msg.id)) {
      const { resolve, reject } = wachtOp.get(msg.id);
      wachtOp.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  await stuur('Page.enable');
  await stuur('Runtime.enable');
  await stuur('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await stuur('Page.navigate', { url: BASE + '/' });
  await wacht(1400);

  // opnamelus
  const loop = (async () => {
    while (!stoppen) {
      try {
        const r = await stuur('Page.captureScreenshot', { format: 'jpeg', quality: 80, fromSurface: true });
        const nu = Date.now();
        const bestand = path.join(OUT, `f${String(frames.length).padStart(5, '0')}.jpg`);
        fs.writeFileSync(bestand, Buffer.from(r.data, 'base64'));
        frames.push({ bestand, van: laatste, tot: nu });
        laatste = nu;
      } catch (_) {}
      await wacht(FRAME_MS);
    }
    loopKlaar = true;
  })();

  const eval_ = async (uitdrukking) => {
    const r = await stuur('Runtime.evaluate', { expression: uitdrukking, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const tik = async (sel) => {
    const ok = await eval_(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    if (!ok) throw new Error('niet gevonden: ' + sel);
  };
  const scrol = async (y) => eval_(`(() => { const m = document.querySelector('main'); if (m) m.scrollTop = ${y}; else window.scrollTo(0, ${y}); return true; })()`);

  // 1. inlogscherm
  await wacht(1800);
  // 2. inloggen
  await eval_(`(() => { const w = document.querySelector('#ww'); w.value = 'demo1234'; w.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
  await wacht(900);
  await tik('#loginform button[type="submit"], #loginform button');
  await wacht(3200);
  // 3. overzicht rustig laten zien
  await wacht(2600);
  await scrol(260);
  await wacht(1800);
  await scrol(0);
  await wacht(1200);
  // 4. projecten
  await tik('nav.tabs button[data-tab="projecten"]');
  await wacht(2600);
  await eval_(`(() => { const z = document.querySelector('#pzoek'); if (z) { z.value='a'; z.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
  await wacht(1800);
  await eval_(`(() => { const z = document.querySelector('#pzoek'); if (z) { z.value=''; z.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
  await wacht(1500);
  // 5. websites
  await tik('nav.tabs button[data-tab="websites"]');
  await wacht(2600);
  // 6. detail van de eerste site
  await eval_(`(() => { const r = document.querySelector('main .rijen a[data-site]'); if (r) { r.click(); return true; } return false; })()`).then(async (ok) => {
    if (!ok) await eval_(`(() => { const b = document.querySelector('main .rijen button'); if (b) b.click(); return !!b; })()`);
  });
  await wacht(3000);
  await scrol(300);
  await wacht(1600);
  await scrol(0);
  await wacht(1200);
  // 7. tickets
  await tik('nav.tabs button[data-tab="tickets"]');
  await wacht(2600);
  // 8. ticket openen
  await eval_(`(() => { const r = document.querySelector('main .ticket-rij'); if (r) { r.click(); return true; } return false; })()`);
  await wacht(3000);
  await scrol(220);
  await wacht(1400);
  // 9. instellingen
  await tik('nav.tabs button[data-tab="instellingen"]');
  await wacht(2800);
  await scrol(280);
  await wacht(1400);
  // 10. terug naar overzicht
  await tik('nav.tabs button[data-tab="overzicht"]');
  await wacht(2600);

  stoppen = true;
  while (!loopKlaar) await wacht(50);
  try { ws.close(); } catch (_) {}
  chrome.kill('SIGKILL');

  // tijdlijn: elk frame duurt tot het volgende frame; laatste frame 1.2s
  const eind = Date.now();
  if (frames.length) frames[frames.length - 1].tot = eind;
  const regels = frames.map((f) => {
    const d = Math.max(0.02, (f.tot - f.van) / 1000);
    return `file '${f.bestand.replace(/'/g, "'\\''")}'\nduration ${d.toFixed(3)}`;
  });
  const lijst = path.join(OUT, '..', 'frames.txt');
  fs.writeFileSync(lijst, regels.join('\n') + `\nfile '${frames[frames.length - 1].bestand}'\n`);
  const duur = frames.reduce((s, f) => s + (f.tot - f.van), 0) / 1000;
  fs.writeFileSync(path.join(OUT, '..', 'meta.json'), JSON.stringify({ frames: frames.length, seconden: +duur.toFixed(2), lijst }, null, 2));
  console.log(`klaar: ${frames.length} frames, ${duur.toFixed(1)}s → ${lijst}`);
  process.exit(0);
})().catch((e) => {
  console.error('fout:', e.message);
  try { chrome.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
