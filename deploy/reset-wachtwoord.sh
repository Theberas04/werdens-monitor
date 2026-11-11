#!/usr/bin/env bash
# Wachtwoord vergeten? Zet het beheerderswachtwoord van Werdens Monitor terug.
#
#   bash reset-wachtwoord.sh                 → genereert een nieuw wachtwoord en drukt het af
#   NIEUW=geheim1234 bash reset-wachtwoord.sh → stelt je eigen wachtwoord in
#   DROOG=1 bash reset-wachtwoord.sh         → laat alleen zien wat er zou gebeuren
#
# Kan gewoon vanaf de Proxmox-console in de LXC (als root), of via SSH op de host:
#   pct exec <id> -- bash -c 'bash -c "$(curl -fsSL …/deploy/reset-wachtwoord.sh)"'
set -u

MAP="${MAP:-/opt/werdens-monitor}"
DIENST="${DIENST:-werdens-monitor}"
DB="${DB:-$MAP/data/monitor.db}"
NIEUW="${NIEUW:-}"
DROOG="${DROOG:-0}"

zeg() { printf '%s\n' "$*"; }
stop() { printf 'Fout: %s\n' "$*" >&2; exit 1; }

# ── controles ────────────────────────────────────────────────────────────────
[ -f "$DB" ] || stop "database niet gevonden: $DB (zet MAP= als de app ergens anders staat)"
command -v node >/dev/null 2>&1 || stop "node niet gevonden; is de monitor wel geïnstalleerd?"
if [ "$(id -u)" -ne 0 ] && [ ! -w "$DB" ]; then
  stop "geen schrijfrecht op $DB; draai dit als root (bijvoorbeeld: sudo bash reset-wachtwoord.sh)"
fi
if [ -n "$NIEUW" ] && [ "${#NIEUW}" -lt 8 ]; then
  stop "het nieuwe wachtwoord moet minstens 8 tekens hebben"
fi

zeg "Installatiemap: $MAP"
zeg "Database:       $DB"

# ── wachtwoord terugzetten ───────────────────────────────────────────────────
# De app bewaart het wachtwoord als scrypt-afdruk in de tabel instellingen
# (sleutel admin_hash). Zonder afdruk maakt de app bij de volgende start een
# nieuw wachtwoord en schrijft dat naar data/admin-wachtwoord.txt.
if [ "$DROOG" = "1" ]; then
  zeg "Droogloop: ik zou de afdruk wissen, alle sessies wissen en de dienst herstarten."
  [ -n "$NIEUW" ] && zeg "Droogloop: en daarna jouw opgegeven wachtwoord instellen."
  exit 0
fi

TMPJS="$(mktemp)"
trap 'rm -f "$TMPJS"' EXIT

cat > "$TMPJS" <<'JS'
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.RESET_DB);
db.exec('PRAGMA busy_timeout = 5000');
const nieuw = process.env.RESET_NIEUW || '';

db.exec('DELETE FROM sessies');

const rij = db.prepare("SELECT waarde FROM instellingen WHERE sleutel='admin_naam'").get();
const naam = rij && rij.waarde ? rij.waarde : 'tom';

if (nieuw) {
  const zout = crypto.randomBytes(16).toString('hex');
  const afdruk = zout + ':' + crypto.scryptSync(nieuw, zout, 64).toString('hex');
  db.prepare("INSERT INTO instellingen(sleutel,waarde) VALUES('admin_hash',?) ON CONFLICT(sleutel) DO UPDATE SET waarde=excluded.waarde").run(afdruk);
  // Het bestand met het oude wachtwoord bijwerken, zodat er geen verouderd
  // wachtwoord blijft rondslingeren.
  const bestand = path.join(path.dirname(process.env.RESET_DB), 'admin-wachtwoord.txt');
  try { require('node:fs').writeFileSync(bestand, nieuw + '\n', { mode: 0o600 }); } catch (e) {}
  console.log('Wachtwoord ingesteld voor ' + naam + '.');
} else {
  db.prepare("DELETE FROM instellingen WHERE sleutel='admin_hash'").run();
  console.log('Oude wachtwoord verwijderd; de app maakt bij de start een nieuwe aan.');
}
db.close();
JS

RESET_DB="$DB" RESET_NIEUW="$NIEUW" node "$TMPJS" || stop "kon de database niet bijwerken"

# De app draait als de gebruiker van de installatiemap; laat de bestanden weer
# van die gebruiker zijn (anders kan de dienst na de herstart niet schrijven).
EIGENAAR="$(stat -c '%U' "$MAP" 2>/dev/null || echo '')"
if [ -n "$EIGENAAR" ] && [ "$EIGENAAR" != "root" ]; then
  chown -R "$EIGENAAR" "$MAP/data" 2>/dev/null || true
fi

# ── dienst herstarten ────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$DIENST" >/dev/null 2>&1; then
  zeg "Dienst $DIENST herstarten…"
  systemctl restart "$DIENST" 2>/dev/null || zeg "Let op: herstarten mislukte; start de dienst met de hand."
  sleep 2
else
  zeg "Geen systemd-dienst $DIENST gevonden; start de app zelf opnieuw."
fi

# ── uitkomst ─────────────────────────────────────────────────────────────────
if [ -n "$NIEUW" ]; then
  zeg ""
  zeg "Klaar. Gebruikersnaam staat in de app (standaard: tom)."
  zeg "Nieuw wachtwoord: $NIEUW"
  zeg "Alle oude sessies zijn gewist, dus je moet opnieuw inloggen."
else
  BESTAND="$MAP/data/admin-wachtwoord.txt"
  if [ -f "$BESTAND" ]; then
    WACHTWOORD="$(tr -d '\r\n' < "$BESTAND")"
    zeg ""
    zeg "Klaar. Nieuw wachtwoord: $WACHTWOORD"
    zeg "(staat ook in $BESTAND)"
  else
    zeg ""
    zeg "Klaar. Het nieuwe wachtwoord staat in $BESTAND (verschijnt na de herstart)."
    zeg "Is de app niet herstart, start hem dan met de hand en kijk in dat bestand."
  fi
  zeg "Log in en wijzig het meteen bij Instellingen → Wachtwoord."
fi
