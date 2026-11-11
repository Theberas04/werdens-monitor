#!/usr/bin/env node
'use strict';
// Werdens Monitor — hardware-agent.
// Draai dit op een server die je wilt volgen. Het leest CPU, geheugen, schijven,
// GPU, temperatuur en netwerk uit /proc en /sys en stuurt dat naar de monitor.
// Geen npm, geen root nodig (behalve voor nvidia-smi of sommige /sys-bestanden).
//
// Op de server:
//   BASE_URL=https://monitor.example.nl TOKEN=<token> node werdens-agent.js
// Of via cron, elke minuut:
//   * * * * * BASE_URL=... TOKEN=... node /opt/werdens-agent.js >/dev/null 2>&1
//
// Met EENMALIG=1 doet hij één meting en stopt; handig om te testen.

const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.TOKEN || '';
const INTERVAL = Math.max(15, Number(process.env.INTERVAL || 60));
const EENMALIG = process.env.EENMALIG === '1';

const lees = (pad, standaard = '') => { try { return fs.readFileSync(pad, 'utf8'); } catch { return standaard; } };
const getal = (w, s = null) => { const n = Number(String(w).replace(',', '.')); return Number.isFinite(n) ? n : s; };
const rond = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

function stat() {
  const velden = (lees('/proc/stat').split('\n')[0] || '').trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, systeem = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = velden;
  const bezet = user + nice + systeem + irq + softirq + steal;
  return { bezet, totaal: bezet + idle + iowait };
}
async function cpuGebruik() {
  const a = stat();
  await new Promise((r) => setTimeout(r, 200));
  const b = stat();
  const dt = b.totaal - a.totaal, db = b.bezet - a.bezet;
  return dt > 0 ? rond(Math.min(100, Math.max(0, (db / dt) * 100))) : null;
}
async function cpu() {
  const kernen = os.cpus() || [];
  const eerste = kernen[0] || {};
  const load = os.loadavg();
  return {
    model: String(eerste.model || '').replace(/\s+/g, ' ').trim(),
    kernen: kernen.length,
    mhz: kernen.length ? Math.round(kernen.reduce((s, c) => s + (c.speed || 0), 0) / kernen.length) : null,
    gebruik_pct: await cpuGebruik(),
    load_1: rond(load[0], 2), load_5: rond(load[1], 2), load_15: rond(load[2], 2),
  };
}
function geheugen() {
  const v = {};
  for (const regel of lees('/proc/meminfo').split('\n')) {
    const m = regel.match(/^([A-Za-z_()]+):\s+(\d+)/); if (m) v[m[1]] = Number(m[2]);
  }
  const totaal = v.MemTotal || 0, vrij = v.MemAvailable || v.MemFree || 0;
  const swap = v.SwapTotal || 0, swapVrij = v.SwapFree || 0;
  return {
    totaal_mb: Math.round(totaal / 1024), gebruikt_mb: Math.round(Math.max(0, totaal - vrij) / 1024),
    vrij_mb: Math.round(vrij / 1024), gebruikt_pct: totaal ? rond(((totaal - vrij) / totaal) * 100) : null,
    swap_totaal_mb: Math.round(swap / 1024), swap_gebruikt_mb: Math.round(Math.max(0, swap - swapVrij) / 1024),
    swap_pct: swap ? rond(((swap - swapVrij) / swap) * 100) : null,
  };
}
function schijven() {
  let uit; try { uit = execFileSync('df', ['-kP'], { encoding: 'utf8', timeout: 4000 }); } catch { return []; }
  const gezien = new Set(), lijst = [];
  for (const regel of uit.trim().split('\n').slice(1)) {
    const d = regel.trim().split(/\s+/); if (d.length < 6) continue;
    const [apparaat, blokken, gebruikt, vrij, pct, ...rest] = d;
    const mount = rest.join(' ');
    if (!mount || /^(tmpfs|devtmpfs|overlay|shm|none)$/.test(apparaat)) continue;
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount) && mount !== '/') continue;
    if (gezien.has(mount)) continue; gezien.add(mount);
    lijst.push({ apparaat, mount, totaal_gb: rond((getal(blokken, 0) * 1024) / 1e9),
      gebruikt_gb: rond((getal(gebruikt, 0) * 1024) / 1e9), vrij_gb: rond((getal(vrij, 0) * 1024) / 1e9),
      gebruikt_pct: getal(String(pct).replace('%', ''), null) });
  }
  return lijst.sort((a, b) => (b.totaal_gb || 0) - (a.totaal_gb || 0));
}
function gpu() {
  try {
    const uit = execFileSync('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 4000 });
    const kaarten = uit.trim().split('\n').filter(Boolean).map((regel) => {
      const [index, naam, vram, vramGebruikt, gebruik, temp, watt] = regel.split(',').map((s) => s.trim());
      return { index: getal(index, 0), naam, vram_mb: getal(vram), vram_gebruikt_mb: getal(vramGebruikt),
        gebruik_pct: getal(gebruik), temp_c: getal(temp), watt: getal(watt) };
    });
    if (kaarten.length) return kaarten;
  } catch { /* geen nvidia-smi */ }
  const kaarten = [];
  try {
    for (const naam of fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
      const uevent = lees('/sys/class/drm/' + naam + '/device/uevent');
      const driver = (uevent.match(/DRIVER=([^\n]+)/) || [])[1];
      const vendor = lees('/sys/class/drm/' + naam + '/device/vendor').trim();
      kaarten.push({ index: getal(naam.replace('card', ''), 0), naam: driver ? 'GPU (' + driver + ')' : 'GPU',
        vendor: vendor === '0x10de' ? 'NVIDIA' : vendor === '0x1002' ? 'AMD' : vendor === '0x8086' ? 'Intel' : '',
        vram_mb: null, vram_gebruikt_mb: null, gebruik_pct: null, temp_c: null, watt: null });
    }
  } catch { /* geen drm */ }
  return kaarten;
}
function temperatuur() {
  const zones = [];
  try {
    for (const zone of fs.readdirSync('/sys/class/thermal').filter((n) => /^thermal_zone\d+$/.test(n))) {
      const c = getal(lees('/sys/class/thermal/' + zone + '/temp').trim());
      if (c !== null) zones.push({ zone, soort: lees('/sys/class/thermal/' + zone + '/type').trim(), c: rond(c > 1000 ? c / 1000 : c) });
    }
  } catch { /* geen zones */ }
  return zones;
}
function netwerk() {
  const koppen = [];
  for (const [naam, adressen] of Object.entries(os.networkInterfaces())) {
    for (const a of adressen || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      koppen.push({ naam, adres: a.address, netmask: a.netmask, mac: a.mac });
    }
  }
  let rx = 0, tx = 0;
  for (const regel of lees('/proc/net/dev').split('\n').slice(2)) {
    const m = regel.trim().match(/^([^:]+):\s*(.+)$/); if (!m || m[1] === 'lo') continue;
    const v = m[2].trim().split(/\s+/).map(Number); rx += v[0] || 0; tx += v[8] || 0;
  }
  return { koppen, rx_gb: rond(rx / 1e9, 2), tx_gb: rond(tx / 1e9, 2) };
}
async function verzamel() {
  return {
    hostnaam: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(),
    uptime_s: getal(lees('/proc/uptime').split(' ')[0]),
    cpu: await cpu(), geheugen: geheugen(), schijven: schijven(), gpu: gpu(),
    temperatuur: temperatuur(), netwerk: netwerk(), op: new Date().toISOString(),
  };
}

async function stuur(data) {
  const r = await fetch(BASE + '/api/agent/hardware', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
    body: JSON.stringify(data),
  });
  const tekst = await r.text();
  if (!r.ok) throw new Error('Monitor antwoordde ' + r.status + ': ' + tekst.slice(0, 200));
  return tekst;
}

(async () => {
  if (!BASE || !TOKEN) {
    console.error('Zet BASE_URL en TOKEN in de omgeving.');
    process.exit(1);
  }
  do {
    try {
      const data = await verzamel();
      await stuur(data);
      console.log(new Date().toISOString() + ' verzonden (' + (data.cpu.gebruik_pct ?? '?') + '% CPU)');
    } catch (e) {
      console.error(new Date().toISOString() + ' fout: ' + e.message);
      if (EENMALIG) process.exit(1);
    }
    if (EENMALIG) break;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  } while (true);
})();
