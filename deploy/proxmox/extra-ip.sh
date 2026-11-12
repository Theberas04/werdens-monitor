#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Zet de publieke meldpagina op een EIGEN IP-ADRES van de LXC.
#
# Draai dit op de PROXMOX-HOST (niet in de container). Het script geeft de
# container een tweede netwerkkaart met dat adres, zet PUBLIEK_BIND in
# /etc/werdens-monitor.env en herstart de dienst.
#
#   IP=192.168.1.121 bash <(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/proxmox/extra-ip.sh)
#   CTID=120 IP=192.168.1.121 BRIDGE=vmbr0 bash extra-ip.sh
#   IP=192.168.1.121 bash extra-ip.sh --verwijderen
#   DROOG=1 IP=192.168.1.121 bash extra-ip.sh          # alleen laten zien
#
# Daarna:
#   dashboard   → http://192.168.1.109:8080
#   meldpagina  → http://192.168.1.121:8081
#   Cloudflare  → tunnel-hostname naar http://192.168.1.121:8081
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CTID="${CTID:-120}"
DIENST="${DIENST:-werdens-monitor}"
ENV_FILE="${ENV_FILE:-/etc/werdens-monitor.env}"
POORT="${PUBLIEK_POORT:-8081}"
PREFIX="${PREFIX:-24}"
KAART="${KAART:-eth1}"
DROOG="${DROOG:-0}"
HERSTART="${HERSTART:-auto}"

VERWIJDEREN=0
[ "${1:-}" = "--verwijderen" ] && VERWIJDEREN=1

rood()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
groen() { printf '\033[32m%s\033[0m\n' "$*"; }
let_op() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
stop() { rood "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || stop "Draai dit als root op de Proxmox-host."
command -v pct >/dev/null 2>&1 || stop "Dit is geen Proxmox-host: 'pct' ontbreekt. Draai het script op de host, niet in de container."

pct status "$CTID" >/dev/null 2>&1 || stop "Container $CTID bestaat niet. Zet CTID=... goed."

CONFIG="$(pct config "$CTID")"
# Let op: geen 'sed | head' in een opdrachtvervanging. Met 'set -o pipefail'
# krijgt sed SIGPIPE als head eerder stopt en klapt het hele script eruit;
# awk met 'exit' print één regel zonder pijplijn.
BRIDGE="${BRIDGE:-$(awk '/^net0:/ { n = split($0, d, "bridge="); if (n > 1) { split(d[2], e, ","); print e[1] }; exit }' <<< "$CONFIG")}"
BRIDGE="${BRIDGE:-vmbr0}"
HUIDIG_IP="$(awk '/^net0:/ { n = split($0, d, "ip="); if (n > 1) { split(d[2], e, ","); sub(/\/.*/, "", e[1]); print e[1] }; exit }' <<< "$CONFIG")"
NET1="$(awk '/^net1:/ { sub(/^net1: /, ""); print; exit }' <<< "$CONFIG")"

echo "Container $CTID · brug $BRIDGE · dashboard-IP ${HUIDIG_IP:-onbekend}"

# ── verwijderen ─────────────────────────────────────────────────────────────
if [ "$VERWIJDEREN" = "1" ]; then
  if [ -z "$NET1" ]; then
    let_op "Er is geen net1 om weg te halen."
  else
    echo "net1 nu: $NET1"
    if [ "$DROOG" = "1" ]; then
      echo "DROOG: pct set $CTID -delete net1"
    else
      pct set "$CTID" -delete net1
      groen "net1 verwijderd."
    fi
  fi
  if [ "$DROOG" = "1" ]; then
    echo "DROOG: PUBLIEK_BIND=0.0.0.0 in $ENV_FILE + herstart $DIENST"
    exit 0
  fi
  if pct exec "$CTID" -- test -f "$ENV_FILE" 2>/dev/null; then
    pct exec "$CTID" -- sed -i "s|^PUBLIEK_BIND=.*|PUBLIEK_BIND=0.0.0.0|" "$ENV_FILE"
  fi
  pct exec "$CTID" -- systemctl restart "$DIENST" 2>/dev/null || let_op "Kon $DIENST niet herstarten."
  groen "De meldpagina luistert weer op alle adressen (poort $POORT)."
  exit 0
fi

IP="${IP:-}"
[ -n "$IP" ] || stop "Zet het adres mee: IP=192.168.1.121 bash extra-ip.sh"
[[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || stop "Geen geldig IPv4-adres: $IP"
for o in ${IP//./ }; do [ "$((10#$o))" -le 255 ] || stop "Geen geldig IPv4-adres: $IP"; done
[ "$IP" != "$HUIDIG_IP" ] || stop "$IP is al het dashboard-adres van deze container; kies een ander adres."

# ── is het adres al bezet? ──────────────────────────────────────────────────
if grep -q "ip=$IP/" <<< "$CONFIG"; then
  let_op "Het adres staat al in de configuratie van container $CTID."
elif command -v ping >/dev/null 2>&1 && ping -c 1 -W 1 "$IP" >/dev/null 2>&1; then
  if [ "${FORCE:-0}" = "1" ]; then
    let_op "$IP antwoordt al, maar FORCE=1 staat erop; ik ga door."
  else
    stop "$IP antwoordt al op het netwerk. Kies een vrij adres, of zet FORCE=1 als je zeker weet dat het mag."
  fi
else
  echo "Het adres $IP is vrij."
fi

NETWIJZIGING="name=$KAART,bridge=$BRIDGE,ip=$IP/$PREFIX"
if [ -n "$NET1" ] && [ "$NET1" = "$NETWIJZIGING" ]; then
  echo "net1 staat al goed; alleen de omgeving controleren."
elif [ -n "$NET1" ]; then
  echo "net1 wordt bijgewerkt: $NET1 → $NETWIJZIGING"
else
  echo "net1 wordt toegevoegd: $NETWIJZIGING"
fi

if [ "$DROOG" = "1" ]; then
  echo "DROOG: pct set $CTID -net1 $NETWIJZIGING"
  echo "DROOG: PUBLIEK_BIND=$IP en PUBLIEK_POORT=$POORT in $ENV_FILE"
  echo "DROOG: systemctl restart $DIENST"
  exit 0
fi

# ── 1. tweede netwerkkaart ──────────────────────────────────────────────────
if [ "$NET1" = "$NETWIJZIGING" ]; then
  :
else
  pct set "$CTID" -net1 "$NETWIJZIGING"
  groen "net1 ingesteld."
fi

# ── 2. omgevingsbestand ─────────────────────────────────────────────────────
if pct exec "$CTID" -- test -f "$ENV_FILE" 2>/dev/null; then
  pct exec "$CTID" -- sed -i "s|^PUBLIEK_BIND=.*|PUBLIEK_BIND=$IP|" "$ENV_FILE"
  pct exec "$CTID" -- sed -i "s|^PUBLIEK_POORT=.*|PUBLIEK_POORT=$POORT|" "$ENV_FILE"
  if ! pct exec "$CTID" -- grep -q '^PUBLIEK_BIND=' "$ENV_FILE" 2>/dev/null; then
    pct exec "$CTID" -- sh -c "printf 'PUBLIEK_BIND=%s\n' '$IP' >> '$ENV_FILE'"
  fi
  if ! pct exec "$CTID" -- grep -q '^PUBLIEK_POORT=' "$ENV_FILE" 2>/dev/null; then
    pct exec "$CTID" -- sh -c "printf 'PUBLIEK_POORT=%s\n' '$POORT' >> '$ENV_FILE'"
  fi
  groen "PUBLIEK_BIND=$IP en PUBLIEK_POORT=$POORT staan in $ENV_FILE."
else
  stop "$ENV_FILE bestaat niet in de container. Installeer de monitor eerst (deploy/installeer.sh)."
fi

# ── 3. kaart live zetten (anders pas na een herstart van de container) ──────
KAART_ADDR="$(pct exec "$CTID" -- ip -4 addr show "$KAART" 2>/dev/null || true)"
if [ -n "$KAART_ADDR" ]; then
  if ! grep -q "inet $IP/" <<< "$KAART_ADDR"; then
    pct exec "$CTID" -- ip link set "$KAART" up 2>/dev/null || true
    pct exec "$CTID" -- ip addr add "$IP/$PREFIX" dev "$KAART" 2>/dev/null \
      || let_op "Kon $IP niet meteen aan $KAART hangen; een herstart van de container regelt het."
  fi
else
  if [ "$HERSTART" = "auto" ] || [ "$HERSTART" = "1" ]; then
    let_op "De kaart $KAART is nog niet zichtbaar in de container; ik herstart de container zodat de netwerkconfig actief wordt."
    if ! pct reboot "$CTID" >/dev/null 2>&1; then
      pct stop "$CTID" >/dev/null 2>&1 || true
      pct start "$CTID" >/dev/null 2>&1 || let_op "Kon de container niet starten; start hem zelf opnieuw."
    fi
  fi
fi

# ── 4. dienst herstarten ────────────────────────────────────────────────────
# Na een herstart van de container duurt het even voor pct exec weer werkt.
for _ in $(seq 1 30); do
  pct exec "$CTID" -- true >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$CTID" -- systemctl restart "$DIENST" 2>/dev/null || let_op "Kon $DIENST niet herstarten (bestaat de dienst?)."
sleep 3

# ── 5. controle ─────────────────────────────────────────────────────────────
STATUS=''
for i in 1 2 3 4 5 6 7 8 9 10; do
  if command -v curl >/dev/null 2>&1; then
    STATUS="$(curl -fsS -o /dev/null -w '%{http_code}' "http://$IP:$POORT/healthz" 2>/dev/null || true)"
  else
    STATUS="$(pct exec "$CTID" -- sh -c "command -v curl >/dev/null && curl -fsS -o /dev/null -w '%{http_code}' 'http://$IP:$POORT/healthz'" 2>/dev/null || true)"
  fi
  if [ "$STATUS" = "200" ]; then break; fi
  sleep 2
done

if [ "$STATUS" = "200" ]; then
  groen "De meldpagina antwoordt op http://$IP:$POORT/"
else
  rood "De meldpagina antwoordt nog niet op http://$IP:$POORT/ (status: ${STATUS:-geen antwoord})."
  echo "Controleer in de container:"
  echo "  pct exec $CTID -- ip -4 addr show $KAART"
  echo "  pct exec $CTID -- journalctl -u $DIENST -n 40 --no-pager"
  echo "En controleer de firewall van de container (poort $POORT) als die aanstaat."
  exit 1
fi

cat <<EOF

Klaar. Het dashboard blijft op http://${HUIDIG_IP:-<dashboard-ip>}:8080, de
meldpagina staat nu op http://$IP:$POORT/.

Cloudflare Tunnel (Zero Trust → Tunnels → je tunnel → Public hostname):
  hostname   melden.werdensmedia.nl
  service    http://$IP:$POORT
Staat cloudflared op deze container, dan kan het ook naar
http://127.0.0.1:$POORT — de tunnel hoeft niet op het tweede adres te staan.

Terugdraaien: IP=$IP bash extra-ip.sh --verwijderen
EOF
