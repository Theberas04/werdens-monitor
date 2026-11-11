'use strict';
// Hardware verzamelen zonder agent en zonder npm: alles uit /proc, /sys, os en
// df. Optioneel nvidia-smi voor de GPU. Werkt op een gewone Linux-server en in
// een LXC; wat niet bestaat (geen GPU, geen batterij) wordt gewoon overgeslagen.
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const lees = (pad, standaard = '') => {
  try { return fs.readFileSync(pad, 'utf8'); } catch { return standaard; }
};
const getal = (waarde, standaard = null) => {
  const n = Number(String(waarde).replace(',', '.'));
  return Number.isFinite(n) ? n : standaard;
};
const rond = (n, decimalen = 1) => {
  if (!Number.isFinite(n)) return null;
  const m = 10 ** decimalen;
  return Math.round(n * m) / m;
};

// ── CPU ─────────────────────────────────────────────────────────────────────
function leesStat() {
  const regel = lees('/proc/stat').split('\n')[0] || '';
  const velden = regel.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, systeem = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = velden;
  const bezet = user + nice + systeem + irq + softirq + steal;
  const totaal = bezet + idle + iowait;
  return { bezet, totaal };
}

async function cpuGebruik() {
  const a = leesStat();
  await new Promise((r) => setTimeout(r, 200));
  const b = leesStat();
  const dt = b.totaal - a.totaal;
  const db = b.bezet - a.bezet;
  if (dt <= 0) return null;
  return rond(Math.min(100, Math.max(0, (db / dt) * 100)));
}

async function cpu() {
  const kernen = os.cpus() || [];
  const eerste = kernen[0] || {};
  const model = String(eerste.model || '').replace(/\s+/g, ' ').trim();
  const mhz = kernen.length ? Math.round(kernen.reduce((s, c) => s + (c.speed || 0), 0) / kernen.length) : null;
  let load = null;
  try { load = os.loadavg().map((n) => rond(n, 2)); } catch { /* niet op elke omgeving */ }
  return {
    model, kernen: kernen.length, mhz,
    gebruik_pct: await cpuGebruik(),
    load_1: load ? load[0] : null, load_5: load ? load[1] : null, load_15: load ? load[2] : null,
  };
}

// ── geheugen ────────────────────────────────────────────────────────────────
function geheugen() {
  const velden = {};
  for (const regel of lees('/proc/meminfo').split('\n')) {
    const m = regel.match(/^([A-Za-z_()]+):\s+(\d+)/);
    if (m) velden[m[1]] = Number(m[2]);
  }
  const kb = (k) => (velden[k] || 0);
  const totaal = kb('MemTotal');
  const vrij = kb('MemAvailable') || kb('MemFree');
  const gebruikt = Math.max(0, totaal - vrij);
  const swap_totaal = kb('SwapTotal');
  const swap_vrij = kb('SwapFree');
  return {
    totaal_mb: Math.round(totaal / 1024),
    gebruikt_mb: Math.round(gebruikt / 1024),
    vrij_mb: Math.round(vrij / 1024),
    gebruikt_pct: totaal ? rond((gebruikt / totaal) * 100) : null,
    swap_totaal_mb: Math.round(swap_totaal / 1024),
    swap_gebruikt_mb: Math.round(Math.max(0, swap_totaal - swap_vrij) / 1024),
    swap_pct: swap_totaal ? rond(((swap_totaal - swap_vrij) / swap_totaal) * 100) : null,
  };
}

// ── schijven ────────────────────────────────────────────────────────────────
// df -kP geeft vaste kolommen: bestandssysteem, blokken, gebruikt, vrij,
// percentage, mountpoint. Regel 1 is de kop.
function schijven() {
  let uit;
  try { uit = execFileSync('df', ['-kP'], { encoding: 'utf8', timeout: 4000 }); }
  catch { return []; }
  const gezien = new Set();
  const lijst = [];
  for (const regel of uit.trim().split('\n').slice(1)) {
    const delen = regel.trim().split(/\s+/);
    if (delen.length < 6) continue;
    const [apparaat, blokken, gebruikt, vrij, pct, ...rest] = delen;
    const mount = rest.join(' ');
    if (!mount || /^(tmpfs|devtmpfs|overlay|shm|none)$/.test(apparaat)) continue;
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount) && mount !== '/') continue;
    if (gezien.has(mount)) continue;
    gezien.add(mount);
    const totaal = getal(blokken, 0) * 1024;
    const vrij_b = getal(vrij, 0) * 1024;
    const gebruikt_b = getal(gebruikt, 0) * 1024;
    lijst.push({
      apparaat, mount,
      totaal_gb: rond(totaal / 1e9, 1),
      gebruikt_gb: rond(gebruikt_b / 1e9, 1),
      vrij_gb: rond(vrij_b / 1e9, 1),
      gebruikt_pct: getal(String(pct).replace('%', ''), null),
    });
  }
  // Grootste schijf eerst, zodat de hoofdschijf bovenaan staat.
  return lijst.sort((a, b) => (b.totaal_gb || 0) - (a.totaal_gb || 0));
}

// ── GPU ─────────────────────────────────────────────────────────────────────
// nvidia-smi is de enige betrouwbare bron zonder extra bibliotheken. AMD en
// Intel vallen terug op /sys/class/drm als er een kaart is; gebruik is dan leeg.
function gpu() {
  try {
    const uit = execFileSync('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 4000 });
    const kaarten = uit.trim().split('\n').filter(Boolean).map((regel) => {
      const [index, naam, vram, vram_gebruikt, gebruik, temp, watt] = regel.split(',').map((s) => s.trim());
      return {
        index: getal(index, 0), naam,
        vram_mb: getal(vram), vram_gebruikt_mb: getal(vram_gebruikt),
        gebruik_pct: getal(gebruik), temp_c: getal(temp), watt: getal(watt),
      };
    });
    if (kaarten.length) return kaarten;
  } catch { /* geen nvidia-smi of geen kaart */ }

  const kaarten = [];
  try {
    const namen = fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n));
    for (const naam of namen) {
      const apparaat = lees('/sys/class/drm/' + naam + '/device/uevent');
      const model = (apparaat.match(/DRIVER=([^\n]+)/) || [])[1];
      const vendor = lees('/sys/class/drm/' + naam + '/device/vendor').trim();
      kaarten.push({
        index: getal(naam.replace('card', ''), 0),
        naam: model ? 'GPU (' + model + ')' : 'GPU',
        vendor: vendor === '0x10de' ? 'NVIDIA' : vendor === '0x1002' ? 'AMD' : vendor === '0x8086' ? 'Intel' : '',
        vram_mb: null, vram_gebruikt_mb: null, gebruik_pct: null, temp_c: null, watt: null,
      });
    }
  } catch { /* geen /sys/class/drm */ }
  return kaarten;
}

// ── temperatuur, netwerk, systeem ───────────────────────────────────────────
function temperatuur() {
  const zones = [];
  try {
    for (const zone of fs.readdirSync('/sys/class/thermal').filter((n) => /^thermal_zone\d+$/.test(n))) {
      const ruw = lees('/sys/class/thermal/' + zone + '/temp').trim();
      const soort = lees('/sys/class/thermal/' + zone + '/type').trim();
      const c = getal(ruw);
      if (c === null) continue;
      zones.push({ zone, soort, c: rond(c > 1000 ? c / 1000 : c) });
    }
  } catch { /* geen thermal zones */ }
  return zones;
}

function netwerk() {
  const koppen = [];
  try {
    for (const [naam, adressen] of Object.entries(os.networkInterfaces())) {
      for (const adres of adressen || []) {
        if (adres.internal) continue;
        if (adres.family !== 'IPv4' && adres.family !== 4) continue;
        koppen.push({ naam, adres: adres.address, netmask: adres.netmask, mac: adres.mac });
      }
    }
  } catch { /* geen interfaces */ }
  let rx = 0, tx = 0;
  for (const regel of lees('/proc/net/dev').split('\n').slice(2)) {
    const m = regel.trim().match(/^([^:]+):\s*(.+)$/);
    if (!m || m[1] === 'lo') continue;
    const velden = m[2].trim().split(/\s+/).map(Number);
    rx += velden[0] || 0; tx += velden[8] || 0;
  }
  return { koppen, rx_gb: rond(rx / 1e9, 2), tx_gb: rond(tx / 1e9, 2) };
}

function uptimeS() {
  const eerste = lees('/proc/uptime').split(' ')[0];
  return getal(eerste);
}

async function verzamel() {
  return {
    hostnaam: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptime_s: uptimeS(),
    cpu: await cpu(),
    geheugen: geheugen(),
    schijven: schijven(),
    gpu: gpu(),
    temperatuur: temperatuur(),
    netwerk: netwerk(),
    op: new Date().toISOString(),
  };
}

module.exports = { verzamel, cpu, geheugen, schijven, gpu, temperatuur, netwerk };
