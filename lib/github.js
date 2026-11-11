// GitHub-projecten ophalen: alle repo's van de eigenaar met versie, laatste
// commit, CI-uitslag en open issues. De uitkomst wordt in de database bewaard,
// zodat het dashboard ook zonder token en zonder internet blijft werken.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function leesGhToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    const bestand = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
    const tekst = fs.readFileSync(bestand, 'utf8');
    const m = tekst.match(/oauth_token:\s*(\S+)/);
    if (m) return m[1];
  } catch { /* geen gh-config: dan werkt het zonder token, met minder verzoeken */ }
  return '';
}

// Het token kan uit de omgeving komen, uit de gh-config, of — sinds de
// instellingenpagina — uit de database. Dat laatste wint: wat de gebruiker in
// het dashboard invult hoort te werken zonder herstart.
let eigenToken = '';
function zetToken(t) { eigenToken = String(t || '').trim(); }
function token() { return eigenToken || leesGhToken(); }

// Waar het token vandaan komt, zodat het dashboard eerlijk kan zeggen waarom
// het werkt zonder dat er iets in de instellingen staat.
function tokenBron() {
  if (eigenToken) return 'dashboard';
  if (process.env.GITHUB_TOKEN) return 'omgeving';
  try {
    const bestand = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
    if (/oauth_token:\s*\S+/.test(fs.readFileSync(bestand, 'utf8'))) return 'gh-config';
  } catch { /* geen gh-config */ }
  return '';
}
const EIGENAAR = () => process.env.GITHUB_EIGENAAR || 'Theberas04';

async function api(pad) {
  const res = await fetch('https://api.github.com' + pad, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'WerdensMonitor/1.0',
      ...(token() ? { authorization: 'Bearer ' + token() } : {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 403 || res.status === 429) {
    const rest = res.headers.get('x-ratelimit-remaining');
    throw new Error('GitHub-limiet bereikt (nog ' + (rest || '0') + ' verzoeken dit uur)');
  }
  if (!res.ok) throw new Error('GitHub antwoordde ' + res.status);
  return { status: res.status, data: await res.json() };
}

async function inBatches(lijst, grootte, fn) {
  const uit = [];
  for (let i = 0; i < lijst.length; i += grootte) {
    uit.push(...await Promise.all(lijst.slice(i, i + grootte).map(fn)));
  }
  return uit;
}

async function repoDetail(repo) {
  const naam = repo.name;
  const basis = { naam, url: repo.html_url, zichtbaarheid: repo.private ? 'privé' : 'publiek',
    taal: repo.language || '', beschrijving: repo.description || '', bijgewerkt: repo.pushed_at || '',
    standaard_branch: repo.default_branch || 'main', versie: '', tag: '', commit_sha: '', commit_bericht: '',
    commit_datum: '', ci_status: '', issues: repo.open_issues_count || 0, fout: '' };
  try {
    const [release, tags, commits, runs] = await Promise.all([
      api('/repos/' + EIGENAAR() + '/' + naam + '/releases/latest').catch(() => ({ data: null })),
      api('/repos/' + EIGENAAR() + '/' + naam + '/tags?per_page=1').catch(() => ({ data: null })),
      api('/repos/' + EIGENAAR() + '/' + naam + '/commits?per_page=1').catch(() => ({ data: null })),
      api('/repos/' + EIGENAAR() + '/' + naam + '/actions/runs?per_page=1').catch(() => ({ data: null })),
    ]);
    if (release.data && release.data.tag_name) basis.tag = release.data.tag_name;
    else if (Array.isArray(tags.data) && tags.data[0]) basis.tag = tags.data[0].name;
    basis.versie = (basis.tag || '').replace(/^v(?=\d)/, '');
    if (Array.isArray(commits.data) && commits.data[0]) {
      const c = commits.data[0];
      basis.commit_sha = (c.sha || '').slice(0, 7);
      basis.commit_bericht = (c.commit && c.commit.message || '').split('\n')[0].slice(0, 120);
      basis.commit_datum = c.commit && c.commit.committer ? c.commit.committer.date : '';
      if (!basis.versie) basis.versie = 'commit ' + basis.commit_sha;
    }
    if (runs.data && Array.isArray(runs.data.workflow_runs) && runs.data.workflow_runs[0]) {
      const r = runs.data.workflow_runs[0];
      basis.ci_status = r.status === 'completed' ? (r.conclusion || '') : (r.status || '');
    }
  } catch (e) {
    basis.fout = e.message;
  }
  return basis;
}

// Alle repo's van de eigenaar, ook privé (met token), inclusief forks? Nee:
// alleen eigen werk, dat is wat Tom wil zien.
async function haalProjecten() {
  if (!token()) {
    const fout = new Error('Geen GitHub-token ingesteld');
    fout.code = 'GEEN_TOKEN';
    throw fout;
  }
  const alles = [];
  for (let pagina = 1; pagina <= 5; pagina++) {
    const { data } = await api('/user/repos?per_page=100&affiliation=owner&sort=updated&page=' + pagina);
    if (!Array.isArray(data) || data.length === 0) break;
    alles.push(...data.filter((r) => !r.fork && r.owner && r.owner.login.toLowerCase() === EIGENAAR().toLowerCase()));
    if (data.length < 100) break;
  }
  const details = await inBatches(alles, 5, repoDetail);
  return details;
}

// Wie is dit token? Handig om in de instellingen te laten zien dat het klopt,
// zonder het token zelf terug te sturen.
async function wieIsToken(t) {
  const probe = String(t || token() || '').trim();
  if (!probe) throw new Error('Geen GitHub-token opgegeven');
  const res = await fetch('https://api.github.com/user', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'WerdensMonitor/1.0', authorization: 'Bearer ' + probe },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 401) throw new Error('Dit token wordt door GitHub geweigerd');
  if (!res.ok) throw new Error('GitHub antwoordde ' + res.status);
  const data = await res.json();
  return { login: data.login || '', naam: data.name || '', scopes: res.headers.get('x-oauth-scopes') || '' };
}

module.exports = { haalProjecten, leesGhToken, zetToken, token, tokenBron, wieIsToken, EIGENAAR };