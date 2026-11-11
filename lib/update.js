// Zelf bijwerken: de monitor haalt de nieuwste versie van GitHub, pakt de
// tarball uit en vervangt zijn eigen bestanden. Daarna stopt het proces en
// start systemd het opnieuw — zónder root-rechten en zonder git, want de
// dienst draait als gewone gebruiker.
//
// Wat blijft staan: data/ (database, wachtwoord, .versie.json), en de
// .git-map als die er is. Wat vervangen wordt: server.js, lib/, public/,
// scripts/, deploy/, docs/ en package.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
const REPO = 'Theberas04/werdens-monitor';
const BRANCH = 'main';
const BEWAAR = new Set(['data', '.git', 'node_modules', 'uit', '.env']);

function versieBestand() {
  const dbPad = process.env.DB_PATH || path.join(APP, 'data', 'monitor.db');
  return path.join(path.dirname(dbPad), '.versie.json');
}

function lokaal() {
  let bewaard = {};
  try { bewaard = JSON.parse(fs.readFileSync(versieBestand(), 'utf8')); } catch { bewaard = {}; }
  let versie = '';
  try { versie = require(path.join(APP, 'package.json')).version; } catch { versie = ''; }
  let sha = bewaard.sha || '';
  // Bij een git-installatie (de installer kloont de repo) weten we de versie ook
  // zonder .versie.json. Zo werkt "ben ik actueel?" meteen na een verse install.
  if (!sha) {
    try { sha = execFileSync('git', ['-C', APP, 'rev-parse', 'HEAD'], { stdio: 'pipe' }).toString().trim(); }
    catch { sha = ''; }
  }
  return { sha, versie, geinstalleerd: bewaard.geinstalleerd || '' };
}

function bewaarVersie(sha) {
  const bestand = versieBestand();
  fs.mkdirSync(path.dirname(bestand), { recursive: true });
  fs.writeFileSync(bestand, JSON.stringify({ sha, versie: lokaal().versie, geinstalleerd: new Date().toISOString() }, null, 2));
}

async function laatste(token) {
  const res = await fetch('https://api.github.com/repos/' + REPO + '/commits/' + BRANCH, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'WerdensMonitor/1.0',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error('GitHub antwoordde ' + res.status);
  const c = await res.json();
  return {
    sha: c.sha || '',
    kort: (c.sha || '').slice(0, 7),
    bericht: ((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 140),
    datum: (c.commit && c.commit.committer && c.commit.committer.date) || '',
    url: c.html_url || '',
  };
}

async function controleer(token) {
  const nieuwste = await laatste(token);
  const hier = lokaal();
  return {
    versie: hier.versie,
    lokaal_sha: hier.sha,
    geinstalleerd: hier.geinstalleerd,
    laatste: nieuwste,
    nieuw: !!nieuwste.sha && nieuwste.sha !== hier.sha,
  };
}

// De tarball van de branch, uitpakken in een tijdelijke map, en de bestanden
// één voor één overnemen. `data/` wordt nooit aangeraakt.
async function uitvoeren(token) {
  const nieuwste = await laatste(token);
  const hier = lokaal();
  if (nieuwste.sha && nieuwste.sha === hier.sha) {
    return { ok: true, al_actueel: true, sha: hier.sha, versie: hier.versie, bericht: nieuwste.bericht };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'werdens-update-'));
  const tarball = path.join(tmp, 'bron.tar.gz');
  try {
    const url = 'https://codeload.github.com/' + REPO + '/tar.gz/refs/heads/' + BRANCH;
    const res = await fetch(url, { headers: { 'user-agent': 'WerdensMonitor/1.0' }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('Download mislukt (HTTP ' + res.status + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10000) throw new Error('Download is te klein om een project te zijn');
    fs.writeFileSync(tarball, buf);

    execFileSync('tar', ['-xzf', tarball, '-C', tmp], { stdio: 'pipe' });
    const mappen = fs.readdirSync(tmp, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (!mappen.length) throw new Error('De tarball bevat geen map');
    const bron = path.join(tmp, mappen[0].name);
    if (!fs.existsSync(path.join(bron, 'server.js'))) throw new Error('Dit lijkt niet op Werdens Monitor (server.js ontbreekt)');

    // Eerst controleren of de nieuwe code syntaxfouten heeft; anders zet je een
    // kapotte versie neer en start de dienst niet meer.
    try { execFileSync(process.execPath, ['--check', path.join(bron, 'server.js')], { stdio: 'pipe' }); }
    catch (e) { throw new Error('De nieuwe server.js heeft een syntaxfout; niet bijgewerkt: ' + String(e.stderr || e.message).slice(0, 200)); }

    const overgeslagen = [];
    for (const item of fs.readdirSync(bron, { withFileTypes: true })) {
      if (BEWAAR.has(item.name)) { overgeslagen.push(item.name); continue; }
      fs.cpSync(path.join(bron, item.name), path.join(APP, item.name), { recursive: true, force: true });
    }
    bewaarVersie(nieuwste.sha);
    return { ok: true, sha: nieuwste.sha, versie: lokaal().versie, bericht: nieuwste.bericht, overgeslagen, herstart: true };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* opruimen mag mislukken */ }
  }
}

module.exports = { controleer, uitvoeren, lokaal, bewaarVersie, laatste, APP, REPO };
