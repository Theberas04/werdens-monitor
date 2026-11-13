// Eigen software: de apps die Tom zelf heeft gemaakt en ook gebruikt.
//
// Elke app is een map met een git-repo en een package.json. De versie komt uit
// package.json, de laatste commit uit GitHub. Bijwerken = git pull + de dienst
// herstarten. Zo hoeft Tom maar op één plek (het dashboard) in te loggen en
// niet bij elke app apart met een eigen beheerderswachtwoord.
//
// Veiligheid:
//  - alleen mappen die er echt als een app uitzien (package.json + git);
//  - nooit de map zelf wissen, alleen de registratie;
//  - nooit een update uitvoeren als de werkmap niet schoon is;
//  - paden moeten binnen de huis-map van de dienst liggen.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..');

// De map met de eigen apps. Bij elke aanroep gelezen, zodat een test of een
// andere installatie hem met EIGENAPPS_MAP kan verleggen.
function huis() { return process.env.EIGENAPPS_MAP || os.homedir(); }

function bestaat(pad) {
  try { return fs.statSync(pad).isDirectory(); } catch { return false; }
}

// Een pad moet binnen de huis-map liggen; anders kan een verkeerd pad per
// ongeluk een systeemmap raken.
function veiligPad(ruw) {
  const pad = path.resolve(String(ruw || '').trim());
  const basis = path.resolve(huis());
  if (!pad.startsWith(basis + path.sep) && pad !== basis) {
    throw new Error('De map moet binnen ' + basis + ' liggen');
  }
  if (!bestaat(pad)) throw new Error('De map bestaat niet: ' + pad);
  return pad;
}

function git(pad, args, opties = {}) {
  return execFileSync('git', ['-C', pad, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25000,
    ...opties,
  }).toString().trim();
}

function leesPackage(pad) {
  try { return JSON.parse(fs.readFileSync(path.join(pad, 'package.json'), 'utf8')); }
  catch { return {}; }
}

function versie(pad) {
  const p = leesPackage(pad);
  if (p.version) return String(p.version);
  try {
    const v = fs.readFileSync(path.join(pad, 'VERSION'), 'utf8').trim().split('\n')[0];
    if (v) return v;
  } catch { /* geen VERSION-bestand */ }
  try { return git(pad, ['describe', '--tags', '--always']); } catch { return ''; }
}

function sha(pad) {
  try { return git(pad, ['rev-parse', 'HEAD']); } catch { return ''; }
}

function branch(pad) {
  try { return git(pad, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return 'main'; }
}

function repo(pad) {
  try { return git(pad, ['remote', 'get-url', 'origin']); } catch { return ''; }
}

function schoon(pad) {
  try { return git(pad, ['status', '--porcelain']) === ''; } catch { return false; }
}

// Nieuwste commit op de branch, zonder GitHub-API en zonder token: git ls-remote
// werkt voor elke repo waar de clone bij kan.
function nieuwste(pad, tak) {
  try {
    const uit = git(pad, ['ls-remote', 'origin', 'refs/heads/' + tak]);
    const regel = uit.split('\n').filter(Boolean)[0] || '';
    return regel.split(/\s+/)[0] || '';
  } catch { return ''; }
}

// Is dit een app van Tom? Een map met een git-repo. Niet elke app heeft een
// package.json (sommige zijn alleen HTML/JS); de versie is dan leeg of komt uit
// de tags. Een map zonder git is geen app om bij te werken.
function isApp(pad) {
  return bestaat(pad) && fs.existsSync(path.join(pad, '.git'));
}

// Kandidaat-apps onder de huis-map: één niveau diep, met een package.json en
// een git-repo. Het dashboard zelf zit er ook bij; dat mag.
function kandidaten() {
  let mappen = [];
  try { mappen = fs.readdirSync(huis(), { withFileTypes: true }); } catch { return []; }
  const uit = [];
  for (const d of mappen) {
    if (!d.isDirectory()) continue;
    const pad = path.join(huis(), d.name);
    if (!isApp(pad)) continue;
    const p = leesPackage(pad);
    uit.push({
      pad,
      naam: d.name,
      pkg_naam: p.name || '',
      versie: versie(pad),
      repo: repo(pad),
      tak: branch(pad),
      sha: sha(pad),
    });
  }
  uit.sort((a, b) => String(a.naam).localeCompare(String(b.naam), 'nl'));
  return uit;
}

// Het beeld van één app: wat het dashboard toont. Alles wordt vers gelezen,
// zodat een handmatige git pull meteen zichtbaar is.
function beeld(pad, rij = {}) {
  const p = leesPackage(pad);
  const hier = sha(pad);
  const tak = branch(pad);
  return {
    id: rij.id,
    naam: rij.naam || p.name || path.basename(pad),
    pad,
    repo: rij.repo || repo(pad),
    tak,
    dienst: rij.dienst || '',
    versie: versie(pad),
    sha: hier,
    schoon: schoon(pad),
    nieuwste_sha: rij.nieuwste_sha || '',
    nieuwste_datum: rij.nieuwste_datum || '',
    nieuwste_bericht: rij.nieuwste_bericht || '',
    gecontroleerd: rij.gecontroleerd || '',
    bijgewerkt: rij.bijgewerkt || '',
    fout: rij.fout || '',
    nieuw: !!(rij.nieuwste_sha && hier && rij.nieuwste_sha !== hier),
  };
}

// Bijwerken: eerst kijken of de werkmap schoon is. Zo niet, dan zou een pull
// de wijzigingen van Tom kunnen overschrijven; dat doen we niet.
function werkBij(pad, tak = 'main', dienst = '') {
  if (!isApp(pad)) throw new Error('Geen app-map met package.json en git');
  if (!schoon(pad)) throw new Error('De werkmap heeft nog wijzigingen; commit of ruim ze eerst op');
  const voor = sha(pad);
  const uit = git(pad, ['pull', '--ff-only', 'origin', tak]);
  const na = sha(pad);
  let herstart = '';
  // Alleen herstarten als er echt iets veranderd is; een no-op-pull mag geen
  // dienst(en) onnodig herstarten.
  if (dienst && na !== voor) {
    herstart = herstartDienst(dienst);
  }
  return { voor, na, uit, herstart, versie: versie(pad) };
}

// Herstarten: eerst de systeemdienst van de gebruiker, dan de gewone dienst.
// Lukt geen van beide, dan blijft de code wel bijgewerkt; de melding zegt het.
function herstartDienst(dienst) {
  const kandidaten = [
    ['systemctl', ['--user', 'restart', dienst]],
    ['systemctl', ['restart', dienst]],
  ];
  for (const [cmd, args] of kandidaten) {
    try {
      execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      return 'herstart';
    } catch (e) {
      if (e.code === 'ENOENT') return 'geen systemctl';
      // EACCES/andere fout: volgende kandidaat proberen.
    }
  }
  return 'niet herstart (geen rechten)';
}

module.exports = { huis, APP, bestaat, veiligPad, isApp, kandidaten, beeld, werkBij, versie, sha, branch, repo, schoon, nieuwste, herstartDienst, leesPackage };
