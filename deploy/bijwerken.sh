#!/usr/bin/env bash
# Werdens Monitor bijwerken naar de nieuwste versie op main.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/bijwerken.sh)"
#
# Anders dan de installer doet dit script niets met Node, gebruikers of systemd-
# bestanden: het vervangt alleen de programma-bestanden en herstart de dienst.
# De database in data/ blijft staan. Werkt ook zonder git (tarball-terugval).
#
# Variabelen:
#   MAP    installatiemap, standaard /opt/werdens-monitor
#   DIENST naam van de systemd-dienst, standaard werdens-monitor
set -euo pipefail

REPO="Theberas04/werdens-monitor"
TAK="main"
MAP="${MAP:-/opt/werdens-monitor}"
DIENST="${DIENST:-werdens-monitor}"
UNIT="${UNIT:-/etc/systemd/system/$DIENST.service}"

zeg() { echo "→ $*"; }
stop() { echo "Fout: $*" >&2; exit 1; }

[ -d "$MAP" ] || stop "$MAP bestaat niet; draai eerst de installatie-one-liner."
[ -f "$MAP/server.js" ] || stop "$MAP lijkt geen Werdens Monitor-installatie."
if [ "${DROOG:-0}" != "1" ] && [ "$(id -u)" -ne 0 ]; then stop "draai dit als root (of met sudo)."; fi

OUD="$(node -p "require('$MAP/package.json').version" 2>/dev/null || echo '?')"
zeg "Bijwerken in $MAP (nu versie $OUD)"

cd "$MAP"
mkdir -p data

# De installatiemap is van 'werdens', niet van root. Git noemt dat "dubious
# ownership" en weigert dan te werken. Zet de map daarom één keer op de
# vrijstellingslijst én geef hem per commando mee, zodat het ook zonder
# schrijfbare git-config werkt.
if command -v git >/dev/null 2>&1; then
  git config --global --get-all safe.directory 2>/dev/null | grep -qx "$MAP" \
    || git config --global --add safe.directory "$MAP" 2>/dev/null || true
fi

git_bijwerken() {
  git -c safe.directory="$MAP" fetch --quiet origin "$TAK" 2>/dev/null || return 1
  git -c safe.directory="$MAP" reset --hard --quiet "origin/$TAK" 2>/dev/null || return 1
  NIEUW_SHA="$(git -c safe.directory="$MAP" rev-parse HEAD)"
}

if [ -d "$MAP/.git" ] && command -v git >/dev/null 2>&1 && git_bijwerken; then
  zeg "Bijgewerkt via git"
else
  if [ -d "$MAP/.git" ] && command -v git >/dev/null 2>&1; then
    zeg "git kon de repo niet lezen (eigenaar of netwerk); ik gebruik de tarball"
  else
    zeg "Geen git-installatie; tarball van GitHub gebruiken"
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$TAK" -o "$TMP/bron.tar.gz" \
    || stop "downloaden mislukt"
  [ "$(stat -c%s "$TMP/bron.tar.gz")" -gt 10000 ] || stop "download is te klein"
  tar -xzf "$TMP/bron.tar.gz" -C "$TMP" || stop "uitpakken mislukt"
  BRON="$(find "$TMP" -maxdepth 1 -type d -name '*-*' | head -1)"
  [ -f "$BRON/server.js" ] || stop "de tarball bevat geen server.js"
  node --check "$BRON/server.js" || stop "de nieuwe server.js heeft een syntaxfout; niets vervangen"
  for item in "$BRON"/* "$BRON"/.[!.]*; do
    [ -e "$item" ] || continue
    naam="$(basename "$item")"
    case "$naam" in
      data|.git|.env) continue ;;
    esac
    cp -a "$item" "$MAP/" || stop "kopiëren van $naam mislukt"
  done
  # Zonder git weten we de commit niet uit de bestanden; vraag hem aan de API.
  # Zonder sha blijft het dashboard denken dat er een update klaarstaat.
  NIEUW_SHA="$(curl -fsSL ${GITHUB_TOKEN:+-H "authorization: Bearer $GITHUB_TOKEN"} \
    "https://api.github.com/repos/$REPO/commits/$TAK" 2>/dev/null \
    | grep -oE '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{40}"' | head -1 | grep -oE '[0-9a-f]{40}')"
fi

NIEUW="$(node -p "require('$MAP/package.json').version" 2>/dev/null || echo '?')"
if [ -n "${NIEUW_SHA:-}" ]; then
  printf '{\n  "sha": "%s",\n  "versie": "%s",\n  "geinstalleerd": "%s"\n}\n' \
    "$NIEUW_SHA" "$NIEUW" "$(date -Is)" > data/.versie.json 2>/dev/null || true
fi

# De dienst draait als 'werdens'; de bestanden moeten van hem zijn, anders kan
# hij zich de volgende keer niet zelf bijwerken.
id -u werdens >/dev/null 2>&1 && chown -R werdens:werdens "$MAP" 2>/dev/null || true

# Een installatie van vóór 1.3 gaf de dienst alleen schrijfrechten op $MAP/data;
# dan stopt een update uit het dashboard met EROFS. Repareer de unit meteen.
if [ -f "$UNIT" ]; then
  if grep -q '^ReadWritePaths=' "$UNIT" && ! grep -qx "ReadWritePaths=$MAP" "$UNIT"; then
    zeg "Systemd-unit repareren: schrijfrechten op $MAP"
    if [ "${DROOG:-0}" = "1" ]; then
      echo "   [droog] ReadWritePaths=$MAP in $UNIT"
    else
      sed -i "s|^ReadWritePaths=.*|ReadWritePaths=$MAP|" "$UNIT"
      systemctl daemon-reload 2>/dev/null || zeg "Let op: daemon-reload mislukt; herstart de dienst met de hand"
    fi
  elif grep -q '^ProtectSystem=strict' "$UNIT" && ! grep -q '^ReadWritePaths=' "$UNIT"; then
    zeg "Systemd-unit repareren: ReadWritePaths toevoegen"
    if [ "${DROOG:-0}" = "1" ]; then
      echo "   [droog] ReadWritePaths=$MAP toevoegen aan $UNIT"
    else
      sed -i "/^ProtectSystem=strict/a ReadWritePaths=$MAP" "$UNIT"
      systemctl daemon-reload 2>/dev/null || zeg "Let op: daemon-reload mislukt; herstart de dienst met de hand"
    fi
  fi
fi

if [ "${DROOG:-0}" = "1" ]; then
  echo "Droogloop: bestanden bijgewerkt, dienst niet herstart (versie $OUD → $NIEUW)."
elif systemctl list-unit-files 2>/dev/null | grep -q "^$DIENST.service"; then
  zeg "Dienst herstarten"
  systemctl restart "$DIENST"
  sleep 2
  if systemctl is-active --quiet "$DIENST"; then
    echo "Versie $OUD → $NIEUW; dienst draait."
  else
    journalctl -u "$DIENST" -n 30 --no-pager
    stop "de dienst start niet met de nieuwe versie; zie het logboek hierboven"
  fi
else
  echo "Versie $OUD → $NIEUW. Geen systemd-dienst gevonden; start de app zelf opnieuw."
fi

POORT="$(grep -oP '^PORT=\K[0-9]+' "/etc/$DIENST.env" 2>/dev/null || echo 8080)"
if [ "${DROOG:-0}" != "1" ] && command -v curl >/dev/null 2>&1; then
  STATUS="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$POORT/healthz" 2>/dev/null || echo '')"
  echo "Gezondheid: ${STATUS:-geen antwoord}"
  echo "Adres: http://$(hostname -I | awk '{print $1}'):$POORT"
fi
