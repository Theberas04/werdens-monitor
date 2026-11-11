// Grafieken naar het voorbeeld van Grafana: tijdreeksen uit de eigen database,
// zonder npm en zonder externe Grafana. De server levert alleen de punten; de
// browser tekent ze als SVG. Zo blijft de payload klein en is er niets te
// installeren.
//
// Elke reeks heeft dezelfde vorm:
//   { sleutel, naam, soort, eenheid, drempel, punten: [{ op, waarde }] }
// `op` is een ISO-tijd, `waarde` een getal of null (geen meting in dat venster).

const UREN = { '1u': 1, '6u': 6, '24u': 24, '7d': 168, '30d': 720 };

function grens(uren) {
  return new Date(Date.now() - uren * 3600e3).toISOString();
}

function getal(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Downsamplen: bij een lang venster zijn er te veel punten voor een grafiek.
// We houden per bakje het gemiddelde en het slechtste punt, zodat een storing
// niet wegvalt.
function dunner(punten, max = 240) {
  if (punten.length <= max) return punten;
  const stap = punten.length / max;
  const uit = [];
  for (let i = 0; i < max; i++) {
    const van = Math.floor(i * stap);
    const tot = Math.min(punten.length, Math.floor((i + 1) * stap));
    const stuk = punten.slice(van, tot).filter((p) => p.waarde !== null);
    if (!stuk.length) { uit.push({ op: punten[van] ? punten[van].op : '', waarde: null }); continue; }
    const som = stuk.reduce((s, p) => s + p.waarde, 0);
    uit.push({ op: stuk[0].op, waarde: Math.round((som / stuk.length) * 100) / 100 });
  }
  return uit;
}

// ── databronnen ──────────────────────────────────────────────────────────────

function hostReeksen(db, uren) {
  const van = grens(uren);
  const hosts = db.prepare('SELECT ip, naam, hostnaam FROM hosts ORDER BY ip').all();
  const uit = [];
  for (const h of hosts) {
    const rijen = db.prepare('SELECT op, ping_ms, ok FROM host_controles WHERE ip=? AND op>=? ORDER BY op')
      .all(h.ip, van);
    if (!rijen.length) continue;
    const naam = h.naam || h.hostnaam || h.ip;
    uit.push({
      sleutel: 'host:' + h.ip, naam, soort: 'host', eenheid: 'ms', drempel: 800,
      punten: dunner(rijen.map((r) => ({ op: r.op, waarde: getal(r.ping_ms) }))),
      ok: rijen.filter((r) => r.ok).length, totaal: rijen.length,
      laatste: rijen[rijen.length - 1].op,
    });
  }
  return uit;
}

function serverReeksen(db, uren) {
  const van = grens(uren);
  const servers = db.prepare('SELECT id, naam FROM servers ORDER BY naam').all();
  const uit = [];
  for (const s of servers) {
    const rijen = db.prepare('SELECT op, cpu_pct, ram_pct, disk_pct, gpu_pct, temp_c FROM server_metingen WHERE server_id=? AND op>=? ORDER BY op')
      .all(s.id, van);
    if (!rijen.length) continue;
    const reeks = (veld, eenheid, drempel) => dunner(rijen.map((r) => ({ op: r.op, waarde: getal(r[veld]) })));
    uit.push({
      sleutel: 'server:' + s.id, naam: s.naam, soort: 'server', eenheid: '%', drempel: 90,
      punten: reeks('cpu_pct'), ram: reeks('ram_pct'), disk: reeks('disk_pct'),
      temp: reeks('temp_c'), laatste: rijen[rijen.length - 1].op,
    });
  }
  return uit;
}

function siteReeksen(db, uren) {
  const van = grens(uren);
  const sites = db.prepare('SELECT id, naam FROM sites ORDER BY naam').all();
  const uit = [];
  for (const s of sites) {
    const rijen = db.prepare('SELECT op, ms, ok, code FROM controles WHERE site_id=? AND op>=? ORDER BY op')
      .all(s.id, van);
    if (!rijen.length) continue;
    uit.push({
      sleutel: 'site:' + s.id, naam: s.naam, soort: 'site', eenheid: 'ms', drempel: 2000,
      punten: dunner(rijen.map((r) => ({ op: r.op, waarde: getal(r.ms) }))),
      ok: rijen.filter((r) => r.ok).length, totaal: rijen.length,
      laatste: rijen[rijen.length - 1].op,
    });
  }
  return uit;
}

function apparaatReeksen(db, uren) {
  const van = grens(uren);
  const apparaten = db.prepare('SELECT id, naam FROM apparaten ORDER BY naam').all();
  const uit = [];
  for (const a of apparaten) {
    const rijen = db.prepare("SELECT op, status FROM apparaat_metingen WHERE apparaat_id=? AND op>=?").all(a.id, van);
    if (!rijen.length) continue;
    uit.push({
      sleutel: 'apparaat:' + a.id, naam: a.naam, soort: 'apparaat', eenheid: '',
      punten: dunner(rijen.map((r) => ({ op: r.op, waarde: r.status === 'ok' ? 1 : 0 }))),
      laatste: rijen[rijen.length - 1].op,
    });
  }
  return uit;
}

// Annotaties: de meldingen in hetzelfde venster, zodat je op de grafiek ziet
// wanneer er iets misging (zoals Grafana's annotations).
function annotaties(db, uren) {
  const van = grens(uren);
  return db.prepare("SELECT id, op, ip, soort, bericht, ernst, opgelost FROM alerts WHERE op>=? ORDER BY op")
    .all(van).map((a) => ({
      id: a.id, op: a.op, ip: a.ip, soort: a.soort, bericht: a.bericht,
      ernst: a.ernst || 'gemiddeld', opgelost: a.opgelost || '',
    }));
}

function alles(db, uren) {
  return {
    van: grens(uren), tot: new Date().toISOString(), uren,
    hosts: hostReeksen(db, uren),
    servers: serverReeksen(db, uren),
    sites: siteReeksen(db, uren),
    apparaten: apparaatReeksen(db, uren),
    annotaties: annotaties(db, uren),
  };
}

module.exports = { UREN, alles, hostReeksen, serverReeksen, siteReeksen, apparaatReeksen, annotaties, dunner, grens };
