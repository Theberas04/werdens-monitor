'use strict';
// Tests voor Werdens Monitor. Draaien met: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.ADMIN_PASSWORD = 'testwachtwoord123';
process.env.GITHUB_TOKEN = '';
process.env.PORT = '0';

const { server, db } = require('../server');

let basis;
let koek = '';
let agentToken = '';
let testSite;

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

test.before(async () => {
  // Een nagebootste site met versie in een meta-tag en een stats-endpoint.
  testSite = http.createServer((req, res) => {
    if (req.url === '/api/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ versie: '2.3.4', gebruikers: 4, bestanden: 812, database_mb: 12.5 }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Testsite</title><meta name="version" content="2.3.4"></head><body>ok</body></html>');
  });
  await new Promise((r) => testSite.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = 'http://127.0.0.1:' + server.address().port;
  agentToken = db.prepare("SELECT waarde FROM instellingen WHERE sleutel='agent_token'").get().waarde;
});

test.after(() => {
  server.close();
  testSite.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('healthz antwoordt ok met eigen merkteken', async () => {
  const r = await verzoek('/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
  assert.equal(r.headers.get('x-werdensmonitor'), 'app');
});

test('zonder sessie geen gegevens, maar wel de inlogpagina', async () => {
  const api = await verzoek('/api/overzicht');
  assert.equal(api.status, 401);
  const pagina = await verzoek('/');
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /Werdens Monitor/);
  // Merk- en PWA-bestanden zijn bewust openbaar (logo op de inlogpagina).
  const merk = await verzoek('/assets/werdens-media-logo.png');
  assert.equal(merk.status, 200, 'logo moet zonder sessie laden');
  const favicon = await verzoek('/favicon.svg');
  assert.equal(favicon.status, 200, 'favicon is openbaar');
  // Alles buiten de merk- en PWA-allowlist blijft achter de login.
  const statisch = await verzoek('/sw.js');
  assert.equal(statisch.status, 302, 'overige bestanden pas na inloggen');
});

test('inloggen met het verkeerde en het juiste wachtwoord', async () => {
  const mis = await alsJson('/api/login', { method: 'POST', lichaam: { wachtwoord: 'fout' } });
  assert.equal(mis.status, 401);
  const goed = await verzoek('/api/login', { method: 'POST', lichaam: { wachtwoord: 'testwachtwoord123' } });
  assert.equal(goed.status, 200);
  const set = goed.headers.get('set-cookie');
  assert.match(set, /wm_sess=/);
  assert.match(set, /HttpOnly/);
  koek = set.split(';')[0];
  const ik = await alsJson('/api/ik');
  assert.equal(ik.status, 200);
});

test('sites: validatie, toevoegen, meten en stats', async () => {
  const fout = await alsJson('/api/sites', { method: 'POST', lichaam: { naam: 'Kapot', url: 'ftp://x' } });
  assert.equal(fout.status, 400);
  const zonder = await alsJson('/api/sites', { method: 'POST', lichaam: { url: 'http://example.org' } });
  assert.equal(zonder.status, 400);

  const poort = testSite.address().port;
  const nieuw = await alsJson('/api/sites', {
    method: 'POST',
    lichaam: { naam: 'Testsite', url: 'http://127.0.0.1:' + poort + '/', stats_url: 'http://127.0.0.1:' + poort + '/api/stats', interval_s: 60 },
  });
  assert.equal(nieuw.status, 201);
  const id = nieuw.data.site.id;

  const meting = await alsJson('/api/sites/' + id + '/controleer', { method: 'POST' });
  assert.equal(meting.status, 200);
  assert.equal(meting.data.meting.ok, 1);
  assert.equal(meting.data.meting.versie, '2.3.4');

  const detail = await alsJson('/api/sites/' + id);
  assert.equal(detail.data.site.stats.gebruikers, '4');
  assert.equal(detail.data.site.stats.bestanden, '812');
  assert.ok(detail.data.controles.length >= 1);

  const aanpassen = await alsJson('/api/sites/' + id, { method: 'PATCH', lichaam: { naam: 'Testsite 2', interval_s: 5 } });
  assert.equal(aanpassen.status, 200);
  assert.equal(aanpassen.data.site.naam, 'Testsite 2');
  assert.equal(aanpassen.data.site.interval_s, 30, 'interval wordt op minimaal 30 s geklemd');

  const overzicht = await alsJson('/api/overzicht');
  assert.equal(overzicht.status, 200);
  assert.equal(overzicht.data.samenvatting.sites, 1);
  assert.ok(Array.isArray(overzicht.data.sites[0].geschiedenis));
});

test('tickets: aanmaken, berichten, status en agent-token', async () => {
  const foutIp = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'X', ip: '999.1.1.1' } });
  assert.equal(foutIp.status, 400);

  const gemaakt = await alsJson('/api/tickets', { method: 'POST', lichaam: { titel: 'Website traag', ip: '192.168.1.50', prioriteit: 'hoog', omschrijving: 'Sinds de update duurt laden 8 seconden.' } });
  assert.equal(gemaakt.status, 201);
  const id = gemaakt.data.ticket.id;

  const detail = await alsJson('/api/tickets/' + id);
  assert.equal(detail.data.berichten.length, 1, 'omschrijving wordt het eerste bericht');
  assert.equal(detail.data.ticket.status, 'open');
  assert.ok(detail.data.context);

  const bericht = await alsJson('/api/tickets/' + id + '/berichten', { method: 'POST', lichaam: { bericht: 'Ik kijk mee.' } });
  assert.equal(bericht.status, 201);
  assert.equal(bericht.data.berichten.length, 2);

  const mis = await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { status: 'bestaat-niet' } });
  assert.equal(mis.status, 400);
  const goed = await alsJson('/api/tickets/' + id, { method: 'PATCH', lichaam: { status: 'in behandeling' } });
  assert.equal(goed.data.ticket.status, 'in behandeling');

  // agent-API
  const zonderToken = await verzoek('/api/agent/tickets');
  assert.equal(zonderToken.status, 401);
  const agent = await fetch(basis + '/api/agent/tickets', { headers: { authorization: 'Bearer ' + agentToken } });
  assert.equal(agent.status, 200);
  const lijst = await agent.json();
  assert.ok(lijst.tickets.some((t) => t.id === id));

  const agentDetail = await fetch(basis + '/api/agent/tickets/' + id, { headers: { authorization: 'Bearer ' + agentToken } });
  assert.equal(agentDetail.status, 200);
  const agentBericht = await fetch(basis + '/api/agent/tickets/' + id + '/berichten', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + agentToken, 'content-type': 'application/json' },
    body: JSON.stringify({ bericht: 'Ik heb de logs bekeken.', status: 'wacht op Tom' }),
  });
  assert.equal(agentBericht.status, 201);
  const na = await alsJson('/api/tickets/' + id);
  assert.equal(na.data.ticket.status, 'wacht op Tom');
  assert.equal(na.data.berichten.at(-1).rol, 'agent');

  const geenBeheer = await fetch(basis + '/api/instellingen', { headers: { authorization: 'Bearer ' + agentToken } });
  assert.equal(geenBeheer.status, 401, 'agent-token geeft geen beheerdersrechten');
});

test('host aftasten weigert onzin en accepteert een lokaal adres', async () => {
  const fout = await alsJson('/api/hosts/scan', { method: 'POST', lichaam: { ip: 'niet-een-ip' } });
  assert.equal(fout.status, 400);
  const goed = await alsJson('/api/hosts/scan', { method: 'POST', lichaam: { ip: '127.0.0.1' } });
  assert.equal(goed.status, 200);
  assert.ok(Array.isArray(goed.data.scan.poorten));
});

test('statische bestanden, PWA en paden buiten public', async () => {
  for (const [pad, type] of [['/manifest.webmanifest', 'manifest'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/sw.js', 'javascript'], ['/favicon.svg', 'svg']]) {
    const r = await verzoek(pad);
    assert.equal(r.status, 200, pad + ' moet bestaan');
    assert.match(r.headers.get('content-type'), new RegExp(type === 'manifest' ? 'manifest' : type));
  }
  const verboden = await verzoek('/%2e%2e/server.js');
  assert.ok([403, 404].includes(verboden.status), 'pad buiten public moet geweigerd worden');
  const verboden2 = await verzoek('/..%2fserver.js');
  assert.ok([403, 404].includes(verboden2.status));
});

test('elk inline script compileert en elk script-bestand bestaat', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const blokken = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blokken.length, 1, 'één inline script in deze app');
  assert.doesNotThrow(() => new vm.Script(blokken[0]));
  const bronnen = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of bronnen) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', src.replace(/^\//, ''))), src + ' ontbreekt');
  }
});

test('servers: toevoegen, meten via de agent en detail lezen', async () => {
  const gemaakt = await alsJson('/api/servers', { method: 'POST', lichaam: { naam: 'Testsrv', host: '127.0.0.1' } });
  assert.equal(gemaakt.status, 201);
  assert.ok(gemaakt.data.token, 'token wordt uitgegeven');
  const id = gemaakt.data.server.id;

  const lijst = await alsJson('/api/servers');
  assert.ok(lijst.data.servers.some((s) => s.naam === 'Testsrv'));

  const fout = await fetch(basis + '/api/agent/hardware', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': 'fout' },
    body: JSON.stringify({ cpu: {}, geheugen: {} }),
  });
  assert.equal(fout.status, 401, 'onbekend token wordt geweigerd');

  const meting = {
    hostnaam: 'testsrv', platform: 'linux', release: '6.1', arch: 'x64', uptime_s: 90000,
    cpu: { model: 'Test-CPU', kernen: 4, mhz: 2400, gebruik_pct: 12.5, load_1: 0.1, load_5: 0.2, load_15: 0.3 },
    geheugen: { totaal_mb: 1000, gebruikt_mb: 500, vrij_mb: 500, gebruikt_pct: 50, swap_totaal_mb: 0, swap_gebruikt_mb: 0, swap_pct: 0 },
    schijven: [{ apparaat: '/dev/test', mount: '/', totaal_gb: 10, gebruikt_gb: 4, vrij_gb: 6, gebruikt_pct: 40 }],
    gpu: [], temperatuur: [], netwerk: { koppen: [], rx_gb: 0, tx_gb: 0 }, op: new Date().toISOString(),
  };
  const ok = await fetch(basis + '/api/agent/hardware', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': gemaakt.data.token },
    body: JSON.stringify(meting),
  });
  assert.equal(ok.status, 200);

  const detail = await alsJson('/api/servers/' + id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.server.status, 'ok');
  assert.equal(detail.data.server.cpu_pct, 12.5);
  assert.equal(detail.data.server.data.cpu.model, 'Test-CPU');
  assert.ok(detail.data.metingen.length >= 1);

  const verwijderd = await alsJson('/api/servers/' + id, { method: 'DELETE' });
  assert.equal(verwijderd.status, 200);
});

test('Slack-meldingen: webhook instellen, testen en ongeldige URL weigeren', async () => {
  process.env.WM_SLACK_TEST = '1';
  const ontvangen = [];
  const hook = http.createServer((req, res) => {
    let lichaam = '';
    req.on('data', (c) => { lichaam += c; });
    req.on('end', () => {
      ontvangen.push(JSON.parse(lichaam || '{}'));
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + hook.address().port + '/services/T000/B000/xyz';
  try {
    const ongeldig = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_webhook: 'http://example.com/hook' } });
    assert.equal(ongeldig.status, 400, 'geen Slack-URL moet geweigerd worden');
    assert.match(ongeldig.data.fout, /hooks\.slack\.com/);

    const opgeslagen = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_webhook: url, slack_aan: true } });
    assert.equal(opgeslagen.status, 200);
    assert.equal(opgeslagen.data.slack_aan, true);

    const testmelding = await alsJson('/api/slack/test', { method: 'POST' });
    assert.equal(testmelding.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ontvangen.length, 1, 'precies één testbericht');
    assert.match(ontvangen[0].text, /Testmelding/);
    assert.ok(Array.isArray(ontvangen[0].blocks), 'bericht heeft Slack-blokken');

    const gelezen = await alsJson('/api/instellingen');
    assert.equal(gelezen.data.slack_aan, true);
    assert.equal(gelezen.data.slack_webhook, url);

    // De link in het bericht moet naar het dashboard van de gebruiker wijzen,
    // niet naar localhost of het container-IP.
    const onzin = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { publieke_url: 'dashboard.werdensmedia.net' } });
    assert.equal(onzin.status, 400, 'adres zonder http(s) moet geweigerd worden');
    const adres = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { publieke_url: 'https://dashboard.werdensmedia.net/' } });
    assert.equal(adres.status, 200);
    assert.equal(adres.data.publieke_url_actief, 'https://dashboard.werdensmedia.net', 'schuine streep aan het eind valt weg');

    const tweede = await alsJson('/api/slack/test', { method: 'POST' });
    assert.equal(tweede.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ontvangen.length, 2, 'tweede testbericht verstuurd');
    assert.ok(JSON.stringify(ontvangen[1]).includes('https://dashboard.werdensmedia.net'), 'de link wijst naar het publieke dashboard');
    assert.ok(!JSON.stringify(ontvangen[1]).includes('127.0.0.1:'), 'geen localhost-link meer in het bericht');

    // Een echte storing door de meld()-functie moet ook bij Slack aankomen.
    const { meld } = require('../server');
    meld('127.0.0.9', 'host neer', 'Testhost is niet bereikbaar');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ontvangen.length, 3, 'storing door meld() is verstuurd');
    assert.match(ontvangen[2].text, /Testhost is niet bereikbaar/);
    assert.ok(ontvangen[2].blocks[0].text.text.includes('127.0.0.9'), 'IP staat in het bericht');

    // Uitzetten laat de koppeling staan, maar stopt het versturen.
    const uit = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_aan: false } });
    assert.equal(uit.status, 200);
    assert.equal(uit.data.slack_aan, false);
    assert.equal(uit.data.slack_webhook, url);
  } finally {
    hook.close();
  }
});

test('de API beschermt zich tegen een protocol-relatief pad', async () => {
  const r = await fetch(basis + '///api/overzicht', { headers: { cookie: koek } });
  assert.ok([200, 404].includes(r.status));
  const nog = await alsJson('/api/overzicht');
  assert.equal(nog.status, 200, 'server leeft nog');
});
test('netwerk: subnetten opvragen en adressen toevoegen', async () => {
  const r = await alsJson('/api/netwerk');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.subnetten));
  for (const s of r.data.subnetten) {
    assert.ok(s.cidr.includes('/'), 'subnet heeft een CIDR');
    assert.ok(s.eigen.length >= 1, 'subnet kent het eigen adres');
  }

  const onzin = await alsJson('/api/netwerk/toevoegen', { method: 'POST', lichaam: { ips: ['geen-ip', ''] } });
  assert.equal(onzin.status, 400, 'ongeldige adressen worden geweigerd');

  const toe = await alsJson('/api/netwerk/toevoegen', { method: 'POST', lichaam: { ips: ['192.0.2.77', '192.0.2.77'], interval_s: 3600 } });
  assert.equal(toe.status, 200);
  assert.deepEqual(toe.data.toegevoegd, ['192.0.2.77'], 'dubbel adres maar één keer');
  const lijst = await alsJson('/api/hosts');
  assert.ok(lijst.data.hosts.some((h) => h.ip === '192.0.2.77'), 'host staat in de lijst');

  const nog = await alsJson('/api/netwerk/toevoegen', { method: 'POST', lichaam: { ips: ['192.0.2.77'] } });
  assert.deepEqual(nog.data.overgeslagen, ['192.0.2.77'], 'bestaand adres wordt overgeslagen');

  await verzoek('/api/hosts/192.0.2.77', { method: 'DELETE' });
});

test('github-token: ongeldig token wordt geweigerd, leeg token wist het', async () => {
  const fout = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { github_token: 'ghp_dezebestaatniet0000000000000000000000' } });
  assert.equal(fout.status, 400, 'GitHub weigert dit token');
  const inst = await alsJson('/api/instellingen');
  assert.notEqual(inst.data.github_token_bron, 'dashboard', 'een geweigerd token wordt niet bewaard');
});

test('bijwerken: versie opvragen', async () => {
  const r = await alsJson('/api/update');
  assert.equal(r.status, 200);
  assert.equal(r.data.versie, require('../package.json').version);
  assert.equal(r.data.repo, 'Theberas04/werdens-monitor');
});
test('apparaten: UniFi, TrueNAS en generiek toevoegen, meten en verwijderen', async () => {
  // Nagebootste UniFi-controller en TrueNAS op één poort.
  const kast = http.createServer((req, res) => {
    // UniFi OS zet de API onder /proxy/network; de mock accepteert beide.
    const u = String(req.url || '').replace(/^\/proxy\/network/, '');
    const json = (obj, code = 200, extra = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && u === '/api/auth/login') {
      const lichaam = [];
      req.on('data', (c) => lichaam.push(c));
      return req.on('end', () => {
        try {
          const b = JSON.parse(Buffer.concat(lichaam).toString() || '{}');
          if (b.password !== 'goed') return json({ meta: { rc: 'error' } }, 401);
        } catch { /* leeg lichaam */ }
        json({ ok: true }, 200, { 'set-cookie': 'TOKEN=abc; Path=/; HttpOnly' });
      });
    }
    if (u === '/api/self/sites') return json({ data: [{ name: 'default', desc: 'Thuis' }] });
    if (u === '/api/s/default/stat/device') return json({ data: [
      { name: 'AP-1', type: 'uap', model: 'U7-Pro', state: 1, version: '7.0.1', uptime: 864000, ip: '192.168.1.130', num_sta: 3 },
      { name: 'SW-1', type: 'usw', model: 'USW-24-PoE', state: 1, version: '7.0.1', uptime: 864000, ip: '192.168.1.84', num_sta: 2 },
    ] });
    if (u === '/api/s/default/stat/sta') return json({ data: [{ mac: 'aa' }, { mac: 'bb' }, { mac: 'cc' }] });
    if (u === '/api/s/default/stat/health') return json({ data: [
      { subsystem: 'wan', status: 'ok', wan_ip: '203.0.113.9', isp_name: 'KPN' },
      { subsystem: 'lan', status: 'ok', num_user: 3 },
      { subsystem: 'www', status: 'ok', latency: 12, uptime: 99.9 },
    ] });
    if (u === '/api/v2.0/system/info') return json({ hostname: 'truenas', version: '24.04.2', uptime_seconds: 123456, physmem: 34359738368, cores: 8, product_name: 'TRUENAS' });
    if (u === '/api/v2.0/pool') return json([{ name: 'tank', size: 1000000000000, free: 400000000000, status: 'ONLINE', healthy: true }]);
    if (u === '/api/v2.0/disk') return json([{ name: 'sda', type: 'SSD', rotational: false }, { name: 'sdb', type: 'HDD', rotational: true }]);
    if (u === '/api/v2.0/alert/list') {
      if (req.headers.authorization !== 'Bearer goed') return json({ error: 'unauthorized' }, 401);
      return json([]);
    }
    if (u === '/api/gegevens') return json({ naam: 'kastje', versie: '1.2.3', temperatuur: 41.5, online: true });
    // Proxmox VE: antwoorden zitten altijd in een 'data'-wikkel; het token gaat
    // als PVEAPIToken=user@realm!id=secret in de Authorization-kop.
    // Wachtwoord-login: Proxmox geeft eerst een ticket, daarna lees je met een cookie.
    if (u === '/api2/json/access/ticket' && req.method === 'POST') {
      let lichaam = '';
      req.on('data', (c) => { lichaam += c; });
      req.on('end', () => {
        const p = new URLSearchParams(lichaam);
        if (p.get('username') === 'root@pam' && p.get('password') === 'goed') {
          return json({ data: { ticket: 'PVE:goed', CSRFPreventionToken: 'csrf', username: 'root@pam' } });
        }
        json({ data: null }, 401);
      });
      return;
    }
    if (u.startsWith('/api2/json/')) {
      const metTicket = String(req.headers.cookie || '').includes('PVEAuthCookie=PVE:goed');
      if (req.headers.authorization !== 'PVEAPIToken=root@pam!monitor=goed' && !metTicket) return json({ data: null, errors: 'invalid token' }, 401);
      if (u === '/api2/json/version') return json({ data: { version: '8.2.4', release: '8.2' } });
      if (u === '/api2/json/nodes') return json({ data: [
        { node: 'pve1', status: 'online', uptime: 604800, cpu: 0.12, mem: 8589934592, maxmem: 34359738368, disk: 21474836480, maxdisk: 107374182400, loadavg: 0.42 },
        { node: 'pve2', status: 'offline', uptime: 0, cpu: 0, mem: 0, maxmem: 34359738368, disk: 0, maxdisk: 107374182400 },
      ] });
      if (u === '/api2/json/cluster/resources') return json({ data: [
        { type: 'qemu', name: 'docker-vm', status: 'running', node: 'pve1' },
        { type: 'qemu', name: 'test-vm', status: 'stopped', node: 'pve1' },
        { type: 'lxc', name: 'monitor', status: 'running', node: 'pve1' },
        { type: 'lxc', name: 'oude-ct', status: 'stopped', node: 'pve1' },
        { type: 'storage', storage: 'local-lvm', node: 'pve1', disk: 950000000000, maxdisk: 1000000000000 },
      ] });
    }
    json({ fout: 'onbekend pad' }, 404);
  });
  await new Promise((r) => kast.listen(0, '127.0.0.1', r));
  const adres = 'http://127.0.0.1:' + kast.address().port;
  try {
    const unifi = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'UniFi thuis', soort: 'unifi', url: adres, gebruiker: 'admin', geheim: 'goed' } });
    assert.equal(unifi.status, 201, 'UniFi toevoegen lukt');
    assert.equal(unifi.data.apparaat.status, 'ok');
    assert.equal(unifi.data.apparaat.data.apparaten, 2);
    assert.equal(unifi.data.apparaat.data.clients, 3);
    assert.equal(unifi.data.apparaat.data.wan.isp, 'KPN');

    const nas = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'TrueNAS', soort: 'truenas', url: adres, geheim: 'goed' } });
    assert.equal(nas.status, 201);
    assert.equal(nas.data.apparaat.status, 'ok');
    assert.equal(nas.data.apparaat.data.pools.length, 1);
    assert.equal(nas.data.apparaat.data.pools[0].gebruikt_pct, 60);

    const gen = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'Kastje', soort: 'generiek', url: adres + '/api/gegevens' } });
    assert.equal(gen.status, 201);
    assert.equal(gen.data.apparaat.data.code, 200);
    assert.equal(gen.data.apparaat.data.waarden.versie, '1.2.3');

    const pve = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'Proxmox thuis', soort: 'proxmox', url: adres, gebruiker: 'root@pam!monitor', geheim: 'goed' } });
    assert.equal(pve.status, 201, 'Proxmox toevoegen lukt');
    assert.equal(pve.data.apparaat.status, 'fout', 'een offline node is een fout');
    assert.equal(pve.data.apparaat.data.nodes.length, 2);
    assert.equal(pve.data.apparaat.data.nodes_online, 1);
    assert.equal(pve.data.apparaat.data.vms.totaal, 2);
    assert.equal(pve.data.apparaat.data.vms.aan, 1);
    assert.equal(pve.data.apparaat.data.lxc.aan, 1);
    assert.equal(pve.data.apparaat.data.versie, '8.2.4');
    assert.equal(pve.data.apparaat.data.volle_opslag, 1, 'opslag boven 90% telt mee');
    assert.equal(pve.data.apparaat.data.opslag[0].gebruikt_pct, 95);

    // Zonder uitroepteken in de gebruiker proberen we een gewone wachtwoord-login,
    // zodat je geen token hoeft aan te maken.
    const pveWachtwoord = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'Proxmox wachtwoord', soort: 'proxmox', url: adres, gebruiker: 'root@pam', geheim: 'goed' } });
    assert.equal(pveWachtwoord.status, 201, 'Proxmox met wachtwoord toevoegen lukt');
    assert.equal(pveWachtwoord.data.apparaat.status, 'fout', 'offline node blijft een fout');
    assert.equal(pveWachtwoord.data.apparaat.data.nodes.length, 2, 'dezelfde gegevens als met een token');

    const pveWachtwoordFout = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'Proxmox wachtwoord fout', soort: 'proxmox', url: adres, gebruiker: 'root@pam', geheim: 'fout' } });
    assert.equal(pveWachtwoordFout.data.apparaat.status, 'fout');
    assert.match(pveWachtwoordFout.data.apparaat.fout, /inloggen|wachtwoord/i);

    const pveFout = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'Proxmox fout', soort: 'proxmox', url: adres, gebruiker: 'root@pam!monitor', geheim: 'fout' } });
    assert.equal(pveFout.data.apparaat.status, 'fout');
    assert.match(pveFout.data.apparaat.fout, /geweigerd|401/);

    // Een verkeerd wachtwoord/key geeft een fout, geen crash.
    const stuk = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'Stuk', soort: 'truenas', url: adres, geheim: 'fout' } });
    assert.equal(stuk.status, 201);
    assert.equal(stuk.data.apparaat.status, 'fout');
    assert.match(stuk.data.apparaat.fout, /geweigerd|401/);

    const lijst = await alsJson('/api/apparaten');
    assert.equal(lijst.status, 200);
    assert.ok(lijst.data.apparaten.length >= 4, 'alle apparaten staan in de lijst');
    assert.ok(lijst.data.soorten.unifi, 'soorten komen mee voor het formulier');
    assert.ok(!lijst.data.apparaten.some((a) => 'geheim' in a), 'geheimen gaan nooit mee');

    const detail = await alsJson('/api/apparaten/' + unifi.data.apparaat.id);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.data.apparaat.geschiedenis), 'geschiedenis komt mee');

    const gewijzigd = await alsJson('/api/apparaten/' + nas.data.apparaat.id, { method: 'PATCH', lichaam: { naam: 'NAS zolder' } });
    assert.equal(gewijzigd.status, 200);
    assert.equal(gewijzigd.data.apparaat.naam, 'NAS zolder');
    assert.equal(gewijzigd.data.apparaat.heeft_geheim, true, 'leeg geheim laat de key staan');

    const ververs = await alsJson('/api/apparaten/' + unifi.data.apparaat.id + '/verversen', { method: 'POST' });
    assert.equal(ververs.status, 200);
    assert.equal(ververs.data.apparaat.status, 'ok');

    // Onderhoudsvenster op een apparaat: de knop in de UI zet dit venster, en
    // tijdens het venster gaan er geen meldingen meer naar Slack.
    const tot = new Date(Date.now() + 3600e3).toISOString();
    const ond = await alsJson('/api/apparaten/' + pve.data.apparaat.id + '/onderhoud', { method: 'POST', lichaam: { tot, reden: 'test' } });
    assert.equal(ond.status, 201, 'onderhoudsvenster op een apparaat aanmaken');
    assert.equal(ond.data.onderhoud[0].ip, 'apparaat:Proxmox thuis');
    const metOnderhoud = await alsJson('/api/apparaten/' + pve.data.apparaat.id);
    assert.equal(metOnderhoud.data.apparaat.in_onderhoud, true, 'apparaat staat in onderhoud');
    assert.ok(metOnderhoud.data.apparaat.onderhoud.some((o) => o.id === ond.data.onderhoud[0].id), 'venster komt mee in het detail');
    const lijstOnd = await alsJson('/api/apparaten');
    assert.equal(lijstOnd.data.apparaten.find((a) => a.id === pve.data.apparaat.id).in_onderhoud, true, 'lijst toont onderhoud');
    const ondWeg = await alsJson('/api/apparaten/' + pve.data.apparaat.id + '/onderhoud/' + ond.data.onderhoud[0].id, { method: 'DELETE' });
    assert.equal(ondWeg.status, 200, 'onderhoudsvenster stoppen');
    const naOnderhoud = await alsJson('/api/apparaten/' + pve.data.apparaat.id);
    assert.equal(naOnderhoud.data.apparaat.in_onderhoud, false, 'na stoppen is het venster weg');

    const weg = await alsJson('/api/apparaten/' + unifi.data.apparaat.id, { method: 'DELETE' });
    assert.equal(weg.status, 200);
    const na = await alsJson('/api/apparaten/' + unifi.data.apparaat.id);
    assert.equal(na.status, 404, 'verwijderd apparaat is weg');

    const onzin = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'X', soort: 'onbekend', url: 'https://x' } });
    assert.equal(onzin.status, 400, 'onbekend soort wordt geweigerd');
    const geenUrl = await alsJson('/api/apparaten', { method: 'POST', lichaam: { naam: 'X', soort: 'unifi', url: 'geen-url' } });
    assert.equal(geenUrl.status, 400, 'URL zonder http(s) wordt geweigerd');
  } finally {
    kast.close();
  }
});

test('servers: een externe server kan verwijderd worden', async () => {
  const nieuw = await alsJson('/api/servers', { method: 'POST', lichaam: { naam: 'wegwerp' } });
  assert.equal(nieuw.status, 201);
  const id = nieuw.data.server.id;
  const weg = await alsJson('/api/servers/' + id, { method: 'DELETE' });
  assert.equal(weg.status, 200);
  const lijst = await alsJson('/api/servers');
  assert.ok(!lijst.data.servers.some((s) => s.id === id), 'server is weg');
});

test('problemen: ernst, bevestigen, onderhoudsvenster en SLA', async () => {
  const op = new Date().toISOString();
  db.prepare('INSERT INTO alerts(ip,soort,bericht,op,ernst,gemeld_op,meldingen) VALUES(?,?,?,?,?,?,?)')
    .run('192.0.2.55', 'host neer', 'Testhost plat', op, 'kritiek', op, 1);
  try {
    const p = await alsJson('/api/problemen');
    assert.equal(p.status, 200);
    const rij = p.data.problemen.find((a) => a.ip === '192.0.2.55');
    assert.ok(rij, 'de melding staat in het problemenoverzicht');
    assert.equal(rij.ernst, 'kritiek');
    assert.equal(rij.bevestigd, 0);
    assert.ok(p.data.tellingen.kritiek >= 1);
    assert.ok(p.data.ernst.kritiek, 'ernst-labels komen mee voor de UI');

    const ack = await alsJson('/api/problemen/' + rij.id + '/bevestigen', { method: 'POST', lichaam: { notitie: 'ik kijk ernaar' } });
    assert.equal(ack.status, 200);
    assert.equal(ack.data.alert.bevestigd, 1);
    assert.equal(ack.data.alert.bevestigd_door, 'Tom');
    assert.equal(ack.data.alert.notitie, 'ik kijk ernaar');

    const tot = new Date(Date.now() + 3600e3).toISOString();
    const ond = await alsJson('/api/onderhoud', { method: 'POST', lichaam: { ip: '*', tot, reden: 'test' } });
    assert.equal(ond.status, 201, 'globaal onderhoudsvenster aanmaken');
    const p2 = await alsJson('/api/problemen');
    assert.equal(p2.data.onderhoud, true, 'meldingen zijn stilgelegd');

    const sla = await alsJson('/api/sla');
    assert.equal(sla.status, 200);
    assert.ok(Array.isArray(sla.data.hosts), 'SLA-overzicht per host');

    const klaar = await alsJson('/api/problemen/' + rij.id + '/oplossen', { method: 'POST' });
    assert.ok(klaar.data.alert.opgelost, 'melding is opgelost');
  } finally {
    db.prepare("DELETE FROM onderhoud WHERE ip='*'").run();
    db.prepare("DELETE FROM alerts WHERE ip='192.0.2.55'").run();
  }
});

test('grafieken: tijdreeksen en annotaties in één antwoord', async () => {
  const d = await alsJson('/api/grafiek?bereik=24u');
  assert.equal(d.status, 200);
  assert.equal(d.data.bereik, '24u');
  for (const k of ['hosts', 'servers', 'sites', 'apparaten', 'annotaties']) {
    assert.ok(Array.isArray(d.data[k]), k + ' is een lijst');
  }
  assert.ok(Date.parse(d.data.van) < Date.parse(d.data.tot), 'venster heeft een begin en eind');
  const onzin = await alsJson('/api/grafiek?bereik=onzin');
  assert.equal(onzin.data.bereik, '24u', 'onbekend bereik valt terug op 24 uur');
  const eerste = d.data.hosts[0] || d.data.sites[0];
  if (eerste) {
    assert.ok(eerste.punten.length > 0, 'een reeks heeft punten');
    assert.ok(eerste.punten.every((p) => typeof p.op === 'string'), 'elk punt heeft een tijd');
  }
});

test('wachtwoord vergeten: code via Slack, eenmalig geldig, en een nieuw wachtwoord', async () => {
  process.env.WM_SLACK_TEST = '1';
  const ontvangen = [];
  const hook = http.createServer((req, res) => {
    let lichaam = '';
    req.on('data', (c) => { lichaam += c; });
    req.on('end', () => {
      ontvangen.push(JSON.parse(lichaam || '{}'));
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + hook.address().port + '/services/T000/B000/xyz';
  const oudeKoek = koek;
  try {
    const gezet = await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_webhook: url, slack_aan: true } });
    assert.equal(gezet.status, 200, 'webhook instellen lukt');

    const kan = await alsJson('/api/wachtwoord/kan');
    assert.equal(kan.status, 200);
    assert.equal(kan.data.via_slack, true, 'de inlogpagina ziet dat Slack beschikbaar is');

    // Net als de inlogpagina: zonder sessie een code aanvragen.
    koek = '';
    const aanvraag = await alsJson('/api/wachtwoord/vergeten', { method: 'POST', lichaam: {} });
    assert.equal(aanvraag.status, 200);
    assert.equal(aanvraag.data.kanaal, 'slack');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ontvangen.length, 1, 'precies één bericht met de code');
    const tekst = JSON.stringify(ontvangen[0]);
    assert.match(tekst, /Wachtwoord herstellen/, 'bericht heet Wachtwoord herstellen');
    const code = (tekst.match(/\b(\d{6})\b/) || [])[1];
    assert.ok(code, 'de code staat als zes cijfers in het bericht');
    assert.ok(!ontvangen[0].text.includes('admin_hash'), 'geen wachtwoordhash in het bericht');

    // Binnen een minuut nog een code vragen mag niet.
    const teSnel = await alsJson('/api/wachtwoord/vergeten', { method: 'POST', lichaam: {} });
    assert.equal(teSnel.status, 429, 'tweede aanvraag binnen een minuut wordt geweigerd');

    // Een foute code wordt geweigerd.
    const mis = await alsJson('/api/wachtwoord/herstellen', { method: 'POST', lichaam: { code: code === '000000' ? '111111' : '000000', wachtwoord: 'nieuwwachtwoord9' } });
    assert.equal(mis.status, 400);

    // De juiste code zet een nieuw wachtwoord en logt meteen in.
    const goed = await alsJson('/api/wachtwoord/herstellen', { method: 'POST', lichaam: { code, wachtwoord: 'nieuwwachtwoord9' } });
    assert.equal(goed.status, 200, 'code + nieuw wachtwoord lukt');
    const set = goed.koppen.get('set-cookie');
    assert.match(set, /wm_sess=/, 'er wordt meteen een sessie gezet');
    koek = set.split(';')[0];

    // De code is eenmalig: nog een keer gebruiken lukt niet.
    const hergebruik = await alsJson('/api/wachtwoord/herstellen', { method: 'POST', lichaam: { code, wachtwoord: 'anderwachtwoord8' } });
    assert.equal(hergebruik.status, 400, 'code werkt maar één keer');

    // Oud wachtwoord werkt niet meer, nieuw wel.
    const oud = await alsJson('/api/login', { method: 'POST', lichaam: { wachtwoord: 'testwachtwoord123' } });
    assert.equal(oud.status, 401, 'het oude wachtwoord is vervallen');
    const nieuw = await alsJson('/api/login', { method: 'POST', lichaam: { wachtwoord: 'nieuwwachtwoord9' } });
    assert.equal(nieuw.status, 200, 'het nieuwe wachtwoord werkt');
    const sessie = nieuw.koppen.get('set-cookie');
    if (sessie) koek = sessie.split(';')[0];

    // Zonder Slack-webhook bestaat er geen kanaal voor de code.
    await alsJson('/api/instellingen', { method: 'PATCH', lichaam: { slack_aan: false } });
    const zonderSlack = await alsJson('/api/wachtwoord/kan');
    assert.equal(zonderSlack.data.via_slack, false);
    const geenKanaal = await alsJson('/api/wachtwoord/vergeten', { method: 'POST', lichaam: {} });
    assert.equal(geenKanaal.status, 409, 'zonder Slack verwijst de app naar het reset-script');
    assert.match(geenKanaal.data.fout, /reset-wachtwoord/);
  } finally {
    hook.close();
    if (!koek) koek = oudeKoek;
  }
});
