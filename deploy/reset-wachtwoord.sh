#!/usr/bin/env bash
# Wachtwoord vergeten? Zet het beheerderswachtwoord van Werdens Monitor terug.
#
#   bash reset-wachtwoord.sh                 → kiest een nieuw wachtwoord en drukt het af
#   NIEUW=geheim1234 bash reset-wachtwoord.sh → stelt je eigen wachtwoord in
#   DROOG=1 bash reset-wachtwoord.sh         → laat alleen zien wat er zou gebeuren
#
# Het wachtwoord wordt meteen in de database gezet, dus inloggen werkt direct —
# ook als de dienst niet automatisch herstart. Kan vanaf de Proxmox-console in
# de LXC (als root), of vanaf de host:
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

if [ "$DROOG" = "1" ]; then
  zeg "Droogloop: ik zou een nieuw wachtwoord in de database zetten, alle sessies wissen"
  zeg "en de dienst herstarten als die bestaat. Er verandert nu niets."
  [ -n "$NIEUW" ] && zeg "Droogloop: met NIEUW zou jouw wachtwoord worden ingesteld."
  exit 0
fi

# ── wachtwoord terugzetten ───────────────────────────────────────────────────
# De app bewaart het wachtwoord als scrypt-afdruk in de tabel instellingen
# (sleutel admin_hash). We zetten die afdruk hier zelf — niet via "afdruk wissen
# en de app laten herstarten": dan werkt inloggen pas na een herstart en pakt de
# app soms de ADMIN_PASSWORD uit /etc/werdens-monitor.env in plaats van een nieuw
# wachtwoord. Zelf zetten werkt altijd, meteen.
TMPJS="$(mktemp)"
trap 'rm -f "$TMPJS"' EXIT

cat > "$TMPJS" <<'JS'
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.RESET_DB);
db.exec('PRAGMA busy_timeout = 5000');

// Eigen wachtwoord als NIEUW is meegegeven, anders een nieuwe (16 tekens,
// zonder tekens die je snel verkeerd typt).
const nieuw = process.env.RESET_NIEUW || crypto.randomBytes(12).toString('base64url');

const zout = crypto.randomBytes(16).toString('hex');
const afdruk = zout + ':' + crypto.scryptSync(nieuw, zout, 64).toString('hex');

db.prepare("INSERT INTO instellingen(sleutel,waarde) VALUES('admin_hash',?) ON CONFLICT(sleutel) DO UPDATE SET waarde=excluded.waarde").run(afdruk);
db.exec('DELETE FROM sessies');

const rij = db.prepare("SELECT waarde FROM instellingen WHERE sleutel='admin_naam'").get();
const naam = rij && rij.waarde ? rij.waarde : 'tom';

// Het bestand met het wachtwoord bijwerken, zodat er geen verouderd wachtwoord
// blijft rondslingeren en je het later kunt terugvinden.
const bestand = path.join(path.dirname(process.env.RESET_DB), 'admin-wachtwoord.txt');
try {
  require('node:fs').writeFileSync(bestand, nieuw + '\n', { mode: 0o600 });
  require('node:fs').chmodSync(bestand, 0o600);
} catch (e) {}

db.close();
process.stdout.write(nieuw + '\n' + naam + '\n');
JS

UITKOMST="$(RESET_DB="$DB" RESET_NIEUW="$NIEUW" node "$TMPJS")" || stop "kon de database niet bijwerken"
WACHTWOORD="$(printf '%s\n' "$UITKOMST" | sed -n '1p')"
NAAM="$(printf '%s\n' "$UITKOMST" | sed -n '2p')"
[ -n "$WACHTWOORD" ] || stop "kon geen wachtwoord instellen"

# De app draait als de gebruiker van de installatiemap; laat de bestanden weer
# van die gebruiker zijn (anders kan de dienst na de herstart niet schrijven).
EIGENAAR="$(stat -c '%U' "$MAP" 2>/dev/null || echo '')"
if [ -n "$EIGENAAR" ] && [ "$EIGENAAR" != "root" ]; then
  chown -R "$EIGENAAR" "$MAP/data" 2>/dev/null || true
fi

# ── dienst herstarten (mag ook mislukken; inloggen werkt al) ─────────────────
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$DIENST" >/dev/null 2>&1; then
  zeg "Dienst $DIENST herstarten…"
  systemctl restart "$DIENST" 2>/dev/null || zeg "Let op: herstarten mislukte; de dienst draait gewoon door."
  sleep 2
else
  zeg "Geen systemd-dienst $DIENST gevonden; de draaiende app leest het nieuwe wachtwoord direct."
fi

# ── uitkomst ─────────────────────────────────────────────────────────────────
zeg ""
zeg "Klaar. Gebruikersnaam: $NAAM"
zeg "Nieuw wachtwoord:     $WACHTWOORD"
zeg "(staat ook in $MAP/data/admin-wachtwoord.txt)"
zeg "Alle oude sessies zijn gewist, dus je moet opnieuw inloggen."
zeg "Log in en wijzig het meteen bij Instellingen → Wachtwoord als je zelf iets anders wilt."
