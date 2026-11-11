// Netwerkontdekking: welke IP-adressen staan er op het LAN van deze machine?
//
// We kijken naar de eigen interfaces (via os.networkInterfaces), lopen het
// subnet langs en proberen per adres een paar veelgebruikte poorten. Reageert
// er één, dan is de host er. Daarna halen we de naam (reverse DNS) en het
// MAC-adres uit de ARP-tabel van de kernel — dat laatste is de goedkoopste bron
// voor "welk apparaat is dit", en laat ook hosts zien die geen poort open hebben.
//
// Geen ping-programma en geen nmap: een TCP-verbinding met korte time-out is
// genoeg, werkt ook zonder rechten en is met Node zelf te doen.
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const dns = require('node:dns').promises;

// Poorten die bijna elk apparaat wel ergens open heeft staan. Klein houden: dit
// is een bereikbaarheidsscan, geen volledige poortscan. De echte scan per host
// (lib/checks.js) doet daarna de poorten, titels en certificaten.
const PROBE_POORTEN = [22, 80, 443, 445, 3000, 3389, 5000, 631, 8006, 8080, 8443, 9000, 9100];
const PROBE_TIMEOUT_MS = 350;
const MAX_HOSTS = 254;          // per subnet nooit meer dan een /24 aflopen

function ipNaarGetal(ip) {
  return ip.split('.').reduce((som, deel) => (som << 8) + Number(deel), 0) >>> 0;
}
function getalNaarIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
function prefixVanMasker(masker) {
  const n = ipNaarGetal(masker);
  let bits = 0;
  for (let i = 31; i >= 0; i--) { if ((n >>> i) & 1) bits++; else break; }
  return bits;
}
function netwerkAdres(ip, prefix) {
  const masker = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return getalNaarIp(ipNaarGetal(ip) & masker);
}

// Alle eigen IPv4-interfaces die op een LAN hangen. Loopback en link-local
// (169.254.x.x) doen niet mee: daar zit niets nuttigs op.
function subnetten() {
  const uit = [];
  for (const [naam, adressen] of Object.entries(os.networkInterfaces())) {
    for (const a of adressen || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (String(a.address).startsWith('169.254.')) continue;
      const prefix = prefixVanMasker(a.netmask);
      if (prefix < 1 || prefix > 32) continue;
      const netwerk = netwerkAdres(a.address, prefix);
      // Een /16 zou 65.534 adressen betekenen; we scannen het /24-blok om het
      // eigen adres heen en zeggen dat er ook bij.
      const bereik = prefix >= 24 ? { netwerk, prefix } : { netwerk: netwerkAdres(a.address, 24), prefix: 24 };
      const cidr = bereik.netwerk + '/' + bereik.prefix;
      if (uit.some((s) => s.cidr === cidr)) {
        const bestaand = uit.find((s) => s.cidr === cidr);
        if (!bestaand.eigen.includes(a.address)) bestaand.eigen.push(a.address);
        continue;
      }
      uit.push({ interface: naam, eigen: [a.address], netwerk: bereik.netwerk, prefix: bereik.prefix, cidr, volledig: prefix >= 24 });
    }
  }
  return uit;
}

function poortOpen(ip, poort, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let klaar = false;
    const af = (open) => { if (klaar) return; klaar = true; s.destroy(); resolve(open); };
    s.setTimeout(timeout);
    s.once('connect', () => af(true));
    s.once('timeout', () => af(false));
    s.once('error', () => af(false));
    try { s.connect(poort, ip); } catch { af(false); }
  });
}

// ARP-tabel van de kernel: ip -> mac. Alleen op Linux gevuld; op andere
// systemen blijft hij leeg en werken we met de poortprobe alleen.
function arpTabel() {
  const uit = {};
  try {
    const regels = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
    for (const regel of regels) {
      const delen = regel.trim().split(/\s+/);
      if (delen.length < 4) continue;
      const [ip, , vlaggen, mac] = delen;
      if (!ip || mac === '00:00:00:00:00:00') continue;
      if (vlaggen === '0x0') continue;
      uit[ip] = mac;
    }
  } catch { /* geen /proc/net/arp: geen MAC-adressen */ }
  return uit;
}

// Eén adres aftasten. `prober` is instelbaar zodat de tests geen echt netwerk
// nodig hebben.
async function tastAdresAf(ip, { poorten = PROBE_POORTEN, timeout = PROBE_TIMEOUT_MS, prober = poortOpen } = {}) {
  const open = [];
  await Promise.all(poorten.map(async (p) => { if (await prober(ip, p, timeout)) open.push(p); }));
  open.sort((a, b) => a - b);
  return open;
}

// Het hele subnet langs. Adressen waar niets op antwoordt maar die wél in de
// ARP-tabel staan, tellen ook als gevonden: dat zijn apparaten die geen poort
// open hebben (switch, printer in slaapstand, telefoon).
async function ontdek(subnet, opties = {}) {
  const { poorten = PROBE_POORTEN, timeout = PROBE_TIMEOUT_MS, prober = poortOpen, gelijktijdig = 64 } = opties;
  const prefix = Number(subnet.prefix);
  const basis = ipNaarGetal(subnet.netwerk);
  const aantal = Math.min(MAX_HOSTS, Math.pow(2, 32 - prefix) - 2);
  if (aantal < 1) throw new Error('Dit subnet heeft geen bruikbare adressen');

  const eigen = subnet.eigen || [];
  const gevonden = [];
  let volgende = 1;

  async function werk() {
    while (volgende <= aantal) {
      const nummer = volgende++;
      const ip = getalNaarIp(basis + nummer);
      if (eigen.includes(ip)) {
        gevonden.push({ ip, poorten: [], eigen: true, mac: '', hostnaam: os.hostname() });
        continue;
      }
      let open = [];
      try { open = await tastAdresAf(ip, { poorten, timeout, prober }); } catch { open = []; }
      if (open.length) gevonden.push({ ip, poorten: open, eigen: false });
    }
  }
  const werkers = [];
  for (let i = 0; i < Math.max(1, Math.min(gelijktijdig, aantal)); i++) werkers.push(werk());
  await Promise.all(werkers);

  // ARP aanvullen: apparaten zonder open poort maar met een MAC-adres.
  const arp = arpTabel();
  for (const [ip, mac] of Object.entries(arp)) {
    if (ipNaarGetal(ip) <= basis || ipNaarGetal(ip) > basis + aantal) continue;
    const bestaand = gevonden.find((g) => g.ip === ip);
    if (bestaand) { bestaand.mac = mac; continue; }
    gevonden.push({ ip, poorten: [], eigen: eigen.includes(ip), mac });
  }

  // Namen ophalen; dat is één DNS-query per adres en mag mislukken.
  await Promise.all(gevonden.map(async (g) => {
    if (g.hostnaam !== undefined) return;
    try {
      const namen = await dns.reverse(g.ip);
      g.hostnaam = (namen && namen[0]) || '';
    } catch { g.hostnaam = ''; }
    if (!g.mac) g.mac = arp[g.ip] || '';
  }));

  gevonden.sort((a, b) => ipNaarGetal(a.ip) - ipNaarGetal(b.ip));
  return gevonden;
}

module.exports = { subnetten, ontdek, tastAdresAf, arpTabel, ipNaarGetal, getalNaarIp, prefixVanMasker, PROBE_POORTEN };
