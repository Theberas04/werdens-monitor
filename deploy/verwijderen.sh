#!/usr/bin/env bash
# Werdens Monitor van deze machine verwijderen: dienst stoppen, autostart uit,
# systemd-bestand en omgevingsbestand weg. Standaard blijft de installatiemap
# staan (met de database); met ALLES=1 gaat die ook weg.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/verwijderen.sh)"
#
# Variabelen:
#   MAP     installatiemap, standaard /opt/werdens-monitor
#   DIENST  naam van de systemd-dienst, standaard werdens-monitor
#   ALLES   1 = ook de map en de gebruiker verwijderen (database kwijt)
#   DROOG   1 = alleen tonen wat er zou gebeuren
set -euo pipefail

MAP="${MAP:-/opt/werdens-monitor}"
DIENST="${DIENST:-werdens-monitor}"
ALLES="${ALLES:-0}"
DROOG="${DROOG:-0}"

zeg() { echo "→ $*"; }
doe() { if [ "$DROOG" = "1" ]; then echo "   [droog] $*"; else eval "$@"; fi; }
stop() { echo "Fout: $*" >&2; exit 1; }

[ "$DROOG" = "1" ] || [ "$(id -u)" -eq 0 ] || stop "draai dit als root (of met sudo)."

if systemctl list-unit-files 2>/dev/null | grep -q "^$DIENST.service"; then
  zeg "Dienst $DIENST stoppen en autostart uitzetten"
  doe "systemctl stop $DIENST 2>/dev/null || true"
  doe "systemctl disable $DIENST 2>/dev/null || true"
  doe "rm -f /etc/systemd/system/$DIENST.service"
  doe "systemctl daemon-reload"
  zeg "Dienstbestand verwijderd"
else
  zeg "Geen systemd-dienst $DIENST gevonden (al weg, of nooit met systemd gestart)"
fi

if [ -f "/etc/$DIENST.env" ]; then
  zeg "Omgevingsbestand /etc/$DIENST.env verwijderen"
  doe "rm -f /etc/$DIENST.env"
fi

if [ -d "$MAP" ]; then
  if [ "$ALLES" = "1" ]; then
    zeg "Installatiemap $MAP en de database verwijderen"
    doe "rm -rf '$MAP'"
    if id -u werdens >/dev/null 2>&1; then
      zeg "Systeemgebruiker werdens verwijderen"
      doe "userdel werdens 2>/dev/null || true"
    fi
  else
    zeg "Installatiemap $MAP blijft staan (database, .versie.json)"
    echo "  Wil je ook de map en de database weg? Draai hetzelfde commando met ALLES=1."
    echo "  Alleen de map van een oude installatie opruimen: rm -rf $MAP"
  fi
fi

POORT="$(grep -oP '^PORT=\K[0-9]+' "/etc/$DIENST.env" 2>/dev/null || echo 8080)"
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":$POORT "; then
    echo "Let op: poort $POORT is nog in gebruik door een ander proces (ss -ltnp | grep :$POORT)."
  else
    zeg "Poort $POORT is vrij"
  fi
fi

echo
if [ "$DROOG" = "1" ]; then
  echo "Droogloop klaar; er is niets veranderd."
else
  echo "Werdens Monitor is van deze machine verwijderd."
fi
