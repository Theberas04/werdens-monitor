// Apparaten in het homelab: geen server met een agent, maar een kastje of een
// dienst met een eigen API. We praten rechtstreeks met de API van het apparaat:
//
//   unifi    UniFi-controller (UDM/CloudKey of de software-controller): aantal
//            access points, switches, clients en de gezondheid per onderdeel.
//   truenas  TrueNAS SCALE met een API-key: versie, uptime, pools, schijven en
//            openstaande meldingen.
//   proxmox  Proxmox VE via de API met een API-token: nodes met hun belasting,
//            de VM's en containers met hun status, en de opslag per node.
//   generiek elke HTTP-URL die JSON teruggeeft; de scalars worden getoond.
//
// Elke meter geeft hetzelfde vorm terug: { status, data, fout }. `status` is
// 'ok' of 'fout'; `data` is wat de kaart en de detailpagina tonen. Net als bij
// de andere checks is `fetch` injecteerbaar, zodat tests zonder echt apparaat
// draaien.
const http = require('node:http');
const https = require('node:https');

const SOORTEN = {
  unifi: { label: 'UniFi-controller', hint: 'URL van de controller, bijv. https://192.168.1.1' },
  truenas: { label: 'TrueNAS', hint: 'URL van TrueNAS, bijv. http://192.168.1.41' },
  proxmox: { label: 'Proxmox VE', hint: 'URL met poort 8006, bijv. https://192.168.1.10:8006. Gebruiker: root@pam!monitor (token) of root@pam (wachtwoord).' },
  generiek: { label: 'HTTP/JSON', hint: 'Elke URL die JSON teruggeeft' },
};

function schoonUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// Cookies uit een login-antwoord; Node geeft ze via getSetCookie().
function koekjes(res) {
  const lijst = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return lijst.map((k) => String(k).split(';')[0]).filter(Boolean).join('; ');
}

// UniFi: eerst de UniFi-OS-vorm (/api/auth/login, pad onder /proxy/network),
// dan de klassieke controller (/api/login). Beide zetten een cookie.
async function unifiLogin(basis, gebruiker, wachtwoord, fetchFn) {
  const koppen = { 'content-type': 'application/json', 'x-csrf-token': 'null' };
  const lichaam = JSON.stringify({ username: gebruiker, password: wachtwoord });
  const pogingen = [
    { pad: '/api/auth/login', voor: '/proxy/network' },
    { pad: '/api/login', voor: '' },
  ];
  const fouten = [];
  for (const p of pogingen) {
    try {
      const r = await fetchFn(basis + p.pad, { method: 'POST', headers: koppen, body: lichaam, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const cookie = koekjes(r);
        if (cookie) return { voor: p.voor, cookie };
        fouten.push(p.pad + ': geen cookie');
      } else {
        fouten.push(p.pad + ': HTTP ' + r.status);
      }
    } catch (e) { fouten.push(p.pad + ': ' + e.message); }
  }
  throw new Error('inloggen mislukt (' + fouten.join('; ') + ')');
}

async function unifiMeten(apparaat, fetchFn = fetch) {
  const basis = schoonUrl(apparaat.url);
  if (!basis) throw new Error('geen URL ingesteld');
  const { voor, cookie } = await unifiLogin(basis, apparaat.gebruiker, apparaat.geheim, fetchFn);
  const haal = async (pad) => {
    const r = await fetchFn(basis + voor + pad, { headers: { cookie, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(pad + ' gaf HTTP ' + r.status);
    return r.json();
  };
  const [app, klanten, gezondheid, sites] = await Promise.all([
    haal('/api/s/default/stat/device').catch(() => ({ data: [] })),
    haal('/api/s/default/stat/sta').catch(() => ({ data: [] })),
    haal('/api/s/default/stat/health').catch(() => ({ data: [] })),
    haal('/api/self/sites').catch(() => ({ data: [] })),
  ]);
  const apparaten = Array.isArray(app.data) ? app.data : [];
  const clients = Array.isArray(klanten.data) ? klanten.data : [];
  const health = Array.isArray(gezondheid.data) ? gezondheid.data : [];
  const site = (Array.isArray(sites.data) ? sites.data : [])[0] || {};

  const online = apparaten.filter((d) => d.state === 1 || d.state === '1').length;
  const soorten = {};
  for (const d of apparaten) {
    const t = d.type || 'onbekend';
    soorten[t] = (soorten[t] || 0) + 1;
  }
  const wan = health.find((h) => h.subsystem === 'wan') || {};
  const www = health.find((h) => h.subsystem === 'www') || {};
  const lan = health.find((h) => h.subsystem === 'lan') || {};
  const storingen = health.filter((h) => h.status && h.status !== 'ok').map((h) => ({
    onderdeel: h.subsystem || '', status: h.status, aantal: h.num_user || null,
  }));

  return {
    status: apparaten.length && online < apparaten.length ? 'fout' : 'ok',
    data: {
      site: site.desc || site.name || '',
      versie: (apparaten[0] && apparaten[0].version) || '',
      apparaten: apparaten.length,
      online,
      clients: clients.length,
      soorten,
      uptime_s: apparaten.length ? Math.round(Math.min(...apparaten.map((d) => Number(d.uptime) || Infinity))) : null,
      wan: { status: wan.status || '', ip: wan.wan_ip || '', isp: wan.isp_name || '' },
      lan: { status: lan.status || '', gebruikers: lan.num_user ?? null },
      www: { status: www.status || '', latentie_ms: www.latency ?? null, uptime_pct: www.uptime ?? null },
      storingen,
      lijst: apparaten.slice(0, 60).map((d) => ({
        naam: d.name || d.hostname || d.mac || '', model: d.model || '', type: d.type || '',
        online: d.state === 1 || d.state === '1', clients: d.num_sta ?? null, uptime_s: d.uptime ?? null,
        versie: d.version || '', ip: d.ip || '',
      })),
    },
    fout: '',
  };
}

// TrueNAS SCALE: /api/v2.0 met een API-key als Bearer-token. system/info,
// pool, disk en alert/list geven samen een compleet beeld.
async function truenasMeten(apparaat, fetchFn = fetch) {
  const basis = schoonUrl(apparaat.url);
  if (!basis) throw new Error('geen URL ingesteld');
  const key = String(apparaat.geheim || '').trim();
  if (!key) throw new Error('geen API-key ingesteld');
  const haal = async (pad) => {
    const r = await fetchFn(basis + '/api/v2.0' + pad, {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 401 || r.status === 403) throw new Error('API-key geweigerd (HTTP ' + r.status + ')');
    if (!r.ok) throw new Error(pad + ' gaf HTTP ' + r.status);
    return r.json();
  };
  // Een geweigerde key mag niet verdwijnen in de terugval-op-leeg: dan lijkt een
  // kapotte configuratie op een gezond apparaat. Auth-fouten gaan altijd door.
  const authFout = (e) => /geweigerd|401|403/.test(e.message);
  const zacht = (belofte) => belofte.catch((e) => { if (authFout(e)) throw e; return []; });
  const [info, pools, schijven, meldingen] = await Promise.all([
    haal('/system/info'),
    zacht(haal('/pool')),
    zacht(haal('/disk')),
    zacht(haal('/alert/list')),
  ]);
  const poolLijst = (Array.isArray(pools) ? pools : []).map((p) => {
    const totaal = Number(p.size) || 0;
    const vrij = Number(p.free) || 0;
    return {
      naam: p.name || '', status: p.status || '', gezond: p.healthy !== false,
      totaal_gb: Math.round((totaal / 1e9) * 10) / 10,
      vrij_gb: Math.round((vrij / 1e9) * 10) / 10,
      gebruikt_pct: totaal ? Math.round(((totaal - vrij) / totaal) * 1000) / 10 : null,
    };
  });
  const diskLijst = Array.isArray(schijven) ? schijven : [];
  const openMeldingen = (Array.isArray(meldingen) ? meldingen : []).filter((m) => !m.dismissed);
  const kritiek = openMeldingen.filter((m) => String(m.level || '').toUpperCase() === 'CRITICAL');
  const phys = Number(info.physmem) || 0;
  return {
    status: kritiek.length || poolLijst.some((p) => !p.gezond) ? 'fout' : 'ok',
    data: {
      hostnaam: info.hostname || '',
      versie: info.version || '',
      product: info.product_name || info.model || '',
      uptime_s: info.uptime_seconds ?? null,
      geheugen_gb: phys ? Math.round((phys / 1e9) * 10) / 10 : null,
      cores: info.cores ?? null,
      pools: poolLijst,
      schijven: { aantal: diskLijst.length, ssd: diskLijst.filter((d) => d.type === 'SSD' || d.rotational === false).length },
      meldingen: openMeldingen.length,
      kritiek: kritiek.length,
      laatste_meldingen: openMeldingen.slice(0, 8).map((m) => ({ niveau: m.level || '', tekst: m.formatted || m.text || '' })),
    },
    fout: '',
  };
}

// Generiek: één GET op de opgegeven URL. Alles wat een scalar is, komt in de
// lijst met waarden; diepere objecten worden overgeslagen (te veel ruis).
async function generiekMeten(apparaat, fetchFn = fetch) {
  const url = schoonUrl(apparaat.url);
  if (!url) throw new Error('geen URL ingesteld');
  const begin = Date.now();
  const koppen = { accept: 'application/json' };
  if (apparaat.gebruiker) koppen.authorization = 'Bearer ' + apparaat.gebruiker;
  const r = await fetchFn(url, { headers: koppen, signal: AbortSignal.timeout(12000) });
  const ms = Date.now() - begin;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const tekst = await r.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen JSON: alleen de status */ }
  const waarden = {};
  const loop = (obj, voor, diepte) => {
    if (diepte > 2 || !obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (Object.keys(waarden).length >= 24) return;
      const naam = voor ? voor + '.' + k : k;
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') waarden[naam] = v;
      else if (Array.isArray(v)) waarden[naam] = v.length + ' items';
      else loop(v, naam, diepte + 1);
    }
  };
  if (json) loop(json, '', 0);
  return {
    status: 'ok',
    data: { code: r.status, ms, waarden, velden: json ? Object.keys(json).slice(0, 20) : [] },
    fout: '',
  };
}

// Proxmox VE gebruikt een eigen tokenvorm in de Authorization-kop:
//   PVEAPIToken=user@realm!tokenid=secret
// De webinterface draait op poort 8006 met een zelfondertekend certificaat,
// daarom een eigen https-verzoek in plaats van fetch (die weigert zo'n cert).
function haalJson(url, koppen = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('ongeldige URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const opties = { method: 'GET', headers: { accept: 'application/json', ...koppen }, timeout: timeoutMs };
    if (u.protocol === 'https:') opties.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    const req = lib.request(u, opties, (res) => {
      let tekst = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        tekst += c;
        if (tekst.length > 8e6) req.destroy(new Error('antwoord te groot'));
      });
      res.on('end', () => {
        // 401 = token ongeldig, 403 = token geldig maar geen rechten. Dat verschil
        // maakt de melding bruikbaar: bij 403 hoef je niets aan het secret te doen.
        if (res.statusCode === 401) return reject(new Error('Proxmox keurt de token af (HTTP 401) — het secret klopt niet of het token staat uit'));
        if (res.statusCode === 403) return reject(new Error('Proxmox weigert deze opdracht (HTTP 403) — de token is geldig, maar heeft geen rechten voor dit pad'));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        let j;
        try { j = JSON.parse(tekst); } catch { return reject(new Error('geen JSON-antwoord (kreeg HTML?)')); }
        resolve(j && j.data !== undefined ? j.data : j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout na ' + Math.round(timeoutMs / 1000) + ' s')));
    req.on('error', reject);
    req.end();
  });
}

// Ruwe variant van haalJson: geeft de HTTP-code en de tekst terug in plaats van
// te gooien. Alleen voor de rechten-test, zodat één 403 niet de hele test stopt.
function haalRuw(url, koppen = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const begin = Date.now();
    let u;
    try { u = new URL(url); } catch { return reject(new Error('ongeldige URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const opties = { method: 'GET', headers: { accept: 'application/json', ...koppen }, timeout: timeoutMs };
    if (u.protocol === 'https:') opties.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    const req = lib.request(u, opties, (res) => {
      let tekst = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { tekst += c; if (tekst.length > 8e6) req.destroy(new Error('antwoord te groot')); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(tekst); } catch { /* geen JSON, tekst blijft leesbaar */ }
        resolve({ code: res.statusCode, ms: Date.now() - begin, json, tekst: tekst.slice(0, 1200) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout na ' + Math.round(timeoutMs / 1000) + ' s')));
    req.on('error', reject);
    req.end();
  });
}

// Nodig voor de wachtwoord-login van Proxmox: een POST met formuliervelden.
function postJson(url, koppen = {}, lichaam = '', timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('ongeldige URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const opties = {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(lichaam), ...koppen },
      timeout: timeoutMs,
    };
    if (u.protocol === 'https:') opties.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    const req = lib.request(u, opties, (res) => {
      let tekst = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { tekst += c; if (tekst.length > 8e6) req.destroy(new Error('antwoord te groot')); });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('inloggen geweigerd (HTTP ' + res.statusCode + ')'));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        let j;
        try { j = JSON.parse(tekst); } catch { return reject(new Error('geen JSON-antwoord (kreeg HTML?)')); }
        resolve(j && j.data !== undefined ? j.data : j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout na ' + Math.round(timeoutMs / 1000) + ' s')));
    req.on('error', reject);
    req.end(lichaam);
  });
}

// Kop voor de API: token of wachtwoord-ticket. Apart gehouden, zodat de
// rechten-test precies dezelfde weg volgt als de gewone meting.
async function proxmoxKoppen(apparaat, postFn = postJson) {
  const basis = schoonUrl(apparaat.url);
  if (!basis) throw new Error('geen URL ingesteld');
  const token = String(apparaat.gebruiker || '').trim();
  const geheim = String(apparaat.geheim || '').trim();
  if (!token || !geheim) {
    throw new Error('vul bij Gebruiker "user@realm!tokenid" in en bij Wachtwoord/API-key het token-secret');
  }
  // Twee manieren om binnen te komen, allebei met dezelfde gegevensvelden:
  //   root@pam!monitor + token-secret  → API-token (aanbevolen, geen 2FA nodig)
  //   root@pam + wachtwoord            → eerst een ticket ophalen
  // Het uitroepteken verraadt een token; zonder uitroepteken proberen we een
  // gewone login. Zo hoef je niet eerst iets aan te maken in Proxmox.
  if (token.includes('!')) {
    return { basis, wijze: 'token', koppen: { authorization: 'PVEAPIToken=' + token + '=' + geheim } };
  }
  const lichaam = 'username=' + encodeURIComponent(token) + '&password=' + encodeURIComponent(geheim);
  const ticket = await postFn(basis + '/api2/json/access/ticket', {}, lichaam).catch((e) => {
    throw new Error('inloggen met wachtwoord mislukt (' + e.message + '). Controleer het wachtwoord, of gebruik een API-token: root@pam!naam + token-secret.');
  });
  const sleutel = ticket && ticket.ticket;
  if (!sleutel) throw new Error('Proxmox gaf geen ticket terug; staat 2FA uit voor dit account?');
  return { basis, wijze: 'wachtwoord', koppen: { cookie: 'PVEAuthCookie=' + sleutel } };
}

async function proxmoxMeten(apparaat, haalFn = haalJson, postFn = postJson) {
  const { basis, koppen } = await proxmoxKoppen(apparaat, postFn);
  const haal = (pad) => haalFn(basis + '/api2/json' + pad, koppen);
  // 401 = token ongeldig, dat moet altijd melden. 403 = geldig token zonder
  // rechten op dit pad: dan gaan we door met wat we wél hebben, zodat de
  // melding over ontbrekende rechten gaat en niet over een kapot token.
  const zacht = (belofte) => belofte.catch((e) => {
    if (/401/.test(String(e && e.message))) throw e;
    return [];
  });

  const [versie, nodes, resources] = await Promise.all([
    zacht(haal('/version')),
    zacht(haal('/nodes')),
    zacht(haal('/cluster/resources')),
  ]);

  // De cijfers per node (cpu, geheugen, schijf, uptime) zitten niet altijd in
  // /nodes: zonder Sys.Audit op /nodes/<node> geeft Proxmox alleen namen en
  // status. /cluster/resources heeft ze wel, dus we vullen aan vanuit die lijst.
  const nodeResources = (Array.isArray(resources) ? resources : []).filter((r) => r && r.type === 'node');
  const perNode = new Map();
  for (const r of nodeResources) perNode.set(r.node || r.id || '', r);

  const maakNode = (n, x) => {
    const kies = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b);
    const ram = Number(kies(n.mem, x.mem)) || 0, maxram = Number(kies(n.maxmem, x.maxmem)) || 0;
    const disk = Number(kies(n.disk, x.disk)) || 0, maxdisk = Number(kies(n.maxdisk, x.maxdisk)) || 0;
    const cpu = kies(n.cpu, x.cpu);
    const uptime = kies(n.uptime, x.uptime);
    const load = kies(n.loadavg, x.loadavg);
    return {
      naam: n.node || x.node || x.id || '',
      status: n.status || x.status || 'onbekend',
      uptime_s: uptime !== undefined && uptime !== null ? uptime : null,
      cpu_pct: cpu !== undefined && cpu !== null ? Math.round(Number(cpu) * 1000) / 10 : null,
      ram_pct: maxram ? Math.round((ram / maxram) * 1000) / 10 : null,
      ram_gb: ram ? Math.round((ram / 1e9) * 10) / 10 : null,
      ram_totaal_gb: maxram ? Math.round((maxram / 1e9) * 10) / 10 : null,
      disk_pct: maxdisk ? Math.round((disk / maxdisk) * 1000) / 10 : null,
      load: load !== undefined && load !== null ? Math.round(Number(load) * 100) / 100 : null,
    };
  };

  const nodeLijst = (Array.isArray(nodes) ? nodes : []).map((n) => maakNode(n, perNode.get(n.node || '') || {}));
  // Geen /nodes-antwoord? Dan is /cluster/resources de enige bron.
  if (!nodeLijst.length) for (const r of nodeResources) nodeLijst.push(maakNode(r, r));

  // Een token zonder Sys.Audit ziet de node-namen wel, maar geen cijfers. Dat
  // mag geen groene 'ok' worden: zonder cijfers is er niets te bewaken.
  const zonderCijfers = nodeLijst.filter((n) => n.cpu_pct === null && n.ram_pct === null && n.uptime_s === null);
  const online = nodeLijst.filter((n) => n.status === 'online');
  const offline = nodeLijst.filter((n) => n.status !== 'online');

  const gasten = (Array.isArray(resources) ? resources : []).filter((r) => r && (r.type === 'qemu' || r.type === 'lxc'));
  const tel = (type, status) => gasten.filter((g) => g.type === type && String(g.status || '').toLowerCase() === status).length;
  const gestopt = gasten.filter((g) => String(g.status || '').toLowerCase() !== 'running');

  const opslag = (Array.isArray(resources) ? resources : [])
    .filter((r) => r && r.type === 'storage' && Number(r.maxdisk) > 0)
    .map((r) => ({
      naam: r.storage || r.id || '',
      node: r.node || '',
      gebruikt_pct: Math.round(((Number(r.disk) || 0) / Number(r.maxdisk)) * 1000) / 10,
      totaal_gb: Math.round((Number(r.maxdisk) / 1e9) * 10) / 10,
      vrij_gb: Math.round(((Number(r.maxdisk) - (Number(r.disk) || 0)) / 1e9) * 10) / 10,
    }))
    .sort((a, b) => b.gebruikt_pct - a.gebruikt_pct);

  const volleOpslag = opslag.filter((o) => o.gebruikt_pct >= 90);
  // De app-laag kijkt naar `fout` (niet naar `status`) om een melding te maken,
  // dus een gedeeltelijke storing moet hier ook tekst krijgen.
  const problemen = [];
  if (offline.length) problemen.push('node offline: ' + offline.map((n) => n.naam || '?').join(', '));
  if (volleOpslag.length) problemen.push('opslag bijna vol: ' + volleOpslag.map((o) => o.naam + ' (' + o.gebruikt_pct + '%)').join(', '));
  if (nodeLijst.length && zonderCijfers.length === nodeLijst.length) {
    problemen.push('geen meetgegevens: de API-token ziet alleen de nodenamen (Sys.Audit ontbreekt). Zet in Proxmox bij de token Privilege Separation uit, of geef de token de rol PVEAuditor op pad / met Propagate aan.');
  } else if (!nodeLijst.length) {
    problemen.push('geen nodes of VM\'s zichtbaar: controleer of de token leesrechten heeft (rol PVEAuditor op pad /)');
  }
  return {
    status: problemen.length ? 'fout' : 'ok',
    data: {
      versie: versie && versie.version ? String(versie.version) : '',
      release: versie && versie.release ? String(versie.release) : '',
      nodes: nodeLijst,
      nodes_online: online.length,
      nodes_offline: offline.length,
      uptime_s: online.length ? Math.max(...online.map((n) => Number(n.uptime_s) || 0)) : null,
      vms: { aan: tel('qemu', 'running'), uit: gasten.filter((g) => g.type === 'qemu').length - tel('qemu', 'running'), totaal: gasten.filter((g) => g.type === 'qemu').length },
      lxc: { aan: tel('lxc', 'running'), uit: gasten.filter((g) => g.type === 'lxc').length - tel('lxc', 'running'), totaal: gasten.filter((g) => g.type === 'lxc').length },
      gestopt: gestopt.slice(0, 12).map((g) => ({ naam: g.name || g.id || '', soort: g.type === 'lxc' ? 'LXC' : 'VM', node: g.node || '', status: g.status || '' })),
      opslag,
      volle_opslag: volleOpslag.length,
    },
    fout: problemen.join('; '),
  };
}

// Rechten-test: laat per endpoint zien wat de token wél en niet mag. Dit is de
// vraag die je anders alleen in de Proxmox-GUI kunt beantwoorden, en de snelste
// manier om te zien of een weigering aan de token of aan de rechten ligt.
async function proxmoxRechten(apparaat, haalFn = haalRuw, postFn = postJson) {
  const inlog = await proxmoxKoppen(apparaat, postFn);
  const haal = (pad) => haalFn(inlog.basis + '/api2/json' + pad, inlog.koppen)
    .catch((e) => ({ code: 0, ms: 0, json: null, tekst: e.message }));
  const data = (r) => (r && r.json && r.json.data !== undefined ? r.json.data : null);

  const versie = await haal('/version');
  const permissies = await haal('/access/permissions');
  const nodes = await haal('/nodes');
  const resources = await haal('/cluster/resources');

  const nodeLijst = Array.isArray(data(nodes)) ? data(nodes) : [];
  const eerste = nodeLijst.length ? String(nodeLijst[0].node || nodeLijst[0].name || '') : '';
  const status = eerste ? await haal('/nodes/' + encodeURIComponent(eerste) + '/status') : null;

  const resLijst = Array.isArray(data(resources)) ? data(resources) : [];
  const tel = (t) => resLijst.filter((x) => x && x.type === t).length;
  const permMap = data(permissies) && typeof data(permissies) === 'object' ? data(permissies) : null;
  const heeftErgens = (naam) => {
    if (!permMap) return null;
    for (const pad of Object.keys(permMap)) {
      const m = permMap[pad];
      if (m && typeof m === 'object' && (m[naam] === 1 || m[naam] === true)) return true;
    }
    return false;
  };

  const rijen = [];
  const voeg = (pad, r, uitleg, detail) => {
    const d = data(r);
    let aantal = null;
    if (Array.isArray(d)) aantal = d.length;
    else if (d && typeof d === 'object') aantal = Object.keys(d).length;
    rijen.push({ pad, code: r.code, ms: r.ms, aantal, uitleg: uitleg || '', detail: detail || '' });
  };

  voeg('/version', versie, 'versie van de server',
    (data(versie) && data(versie).version) ? 'versie ' + data(versie).version : '');
  voeg('/access/permissions', permissies, 'de rechten die deze token echt heeft',
    permMap ? (Object.keys(permMap).length + ' pad(en) met rechten') : '');
  voeg('/nodes', nodes, 'nodenamen en status',
    nodeLijst.length
      ? nodeLijst.length + ' node(s) · cijfers: ' + (nodeLijst.some((n) => n.cpu !== undefined && n.cpu !== null) ? 'ja' : 'nee')
      : 'geen nodes');
  voeg('/cluster/resources', resources, 'cijfers, VM\'s en opslag',
    resLijst.length
      ? resLijst.length + ' items · ' + tel('node') + ' node, ' + tel('qemu') + ' VM, ' + tel('lxc') + ' container, ' + tel('storage') + ' opslag'
      : 'leeg');
  if (status) {
    voeg('/nodes/' + eerste + '/status', status, 'cijfers van de eerste node',
      (data(status) && data(status).cpu !== undefined && data(status).cpu !== null) ? 'cpu, geheugen en uptime aanwezig' : 'geen cijfers');
  }

  // Wat is de kern? Zo hoeft niemand zelf de API-antwoorden te ontcijferen.
  const problemen = [];
  if (rijen.some((r) => r.code === 401)) {
    problemen.push('De token wordt geweigerd (HTTP 401). Het secret klopt niet of het token staat uit.');
  } else if (rijen.some((r) => r.code === 403)) {
    problemen.push('De token is geldig, maar mag deze onderdelen niet lezen (HTTP 403).');
  }
  if (permMap && !Object.keys(permMap).length) {
    problemen.push('De token heeft geen eigen rechten. Staat Privilege Separation aan, geef dan de token zelf de rol PVEAuditor — niet de gebruiker root@pam.');
  }
  if (permMap && Object.keys(permMap).length && heeftErgens('Sys.Audit') === false) {
    problemen.push('Het recht Sys.Audit ontbreekt. Zonder dat recht geeft Proxmox geen CPU, geheugen, uptime of VM-lijst.');
  }
  if (nodeLijst.length && !nodeLijst.some((n) => n.cpu !== undefined && n.cpu !== null)) {
    problemen.push('/nodes geeft alleen nodenamen zonder cijfers — dat is het bewijs dat Sys.Audit ontbreekt.');
  }
  if (rijen.some((r) => r.code === 0)) {
    problemen.push('Een van de endpoints was niet bereikbaar (netwerk of timeout).');
  }
  if (!problemen.length) problemen.push('Alles leesbaar — de rechten zijn in orde.');

  return {
    ok: problemen.length === 1 && /in orde/.test(problemen[0]),
    url: inlog.basis,
    inloggen: inlog.wijze,
    rijen,
    problemen,
    rechten: permMap
      ? Object.keys(permMap).map((pad) => ({
        pad,
        rechten: Object.keys(permMap[pad] || {}).filter((n) => permMap[pad][n] === 1 || permMap[pad][n] === true),
      }))
      : [],
  };
}

async function meten(apparaat, fetchFn = fetch) {
  const soort = String(apparaat.soort || '').toLowerCase();
  try {
    if (soort === 'unifi') return await unifiMeten(apparaat, fetchFn);
    if (soort === 'truenas') return await truenasMeten(apparaat, fetchFn);
    // Proxmox praat via zijn eigen https-verzoek (zelfondertekend cert), niet via fetch.
    if (soort === 'proxmox') return await proxmoxMeten(apparaat);
    if (soort === 'generiek') return await generiekMeten(apparaat, fetchFn);
    throw new Error('onbekend soort apparaat: ' + soort);
  } catch (e) {
    return { status: 'fout', data: {}, fout: e.message };
  }
}

module.exports = { SOORTEN, meten, unifiMeten, truenasMeten, proxmoxMeten, proxmoxRechten, generiekMeten, schoonUrl, haalJson, haalRuw, postJson, http };
