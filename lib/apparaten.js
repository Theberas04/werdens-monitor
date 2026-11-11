// Apparaten in het homelab: geen server met een agent, maar een kastje of een
// dienst met een eigen API. We praten rechtstreeks met de API van het apparaat:
//
//   unifi    UniFi-controller (UDM/CloudKey of de software-controller): aantal
//            access points, switches, clients en de gezondheid per onderdeel.
//   truenas  TrueNAS SCALE met een API-key: versie, uptime, pools, schijven en
//            openstaande meldingen.
//   generiek elke HTTP-URL die JSON teruggeeft; de scalars worden getoond.
//
// Elke meter geeft hetzelfde vorm terug: { status, data, fout }. `status` is
// 'ok' of 'fout'; `data` is wat de kaart en de detailpagina tonen. Net als bij
// de andere checks is `fetch` injecteerbaar, zodat tests zonder echt apparaat
// draaien.
const http = require('node:http');

const SOORTEN = {
  unifi: { label: 'UniFi-controller', hint: 'URL van de controller, bijv. https://192.168.1.1' },
  truenas: { label: 'TrueNAS', hint: 'URL van TrueNAS, bijv. http://192.168.1.41' },
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

async function meten(apparaat, fetchFn = fetch) {
  const soort = String(apparaat.soort || '').toLowerCase();
  try {
    if (soort === 'unifi') return await unifiMeten(apparaat, fetchFn);
    if (soort === 'truenas') return await truenasMeten(apparaat, fetchFn);
    if (soort === 'generiek') return await generiekMeten(apparaat, fetchFn);
    throw new Error('onbekend soort apparaat: ' + soort);
  } catch (e) {
    return { status: 'fout', data: {}, fout: e.message };
  }
}

module.exports = { SOORTEN, meten, unifiMeten, truenasMeten, generiekMeten, schoonUrl, http };
