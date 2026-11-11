#!/usr/bin/env bash
# Maakt een eigen LXC voor Werdens Monitor op een Proxmox-host en installeert
# de app erin. Dit draai je als root op de Proxmox-host zelf (of via SSH op de
# host), niet in een container.
#
#   CTID=120 ADMIN_PASSWORD='kies-er-een' bash maak-lxc.sh
#
# Variabelen (vooraf zetten of als omgevingsvariabele meegeven):
#   CTID            containernummer; leeg = eerste vrije vanaf 120
#   HOSTNAAM        standaard werdens-monitor
#   CORES           2
#   MEMORY          2048 (MB)
#   SWAP            512 (MB)
#   DISK            8 (GB)
#   STORAGE         rootfs-opslag; leeg = automatisch de eerste actieve images-opslag
#   BRIDGE          vmbr0
#   IP              dhcp (standaard) of bijv. 192.168.1.130/24,gw=192.168.1.1
#   ADMIN_PASSWORD  wachtwoord van het dashboard (verplicht)
#   GITHUB_TOKEN    token voor de Projecten-tab (optioneel)
#   DROOG=1         alleen tonen wat er zou gebeuren, niets aanmaken
set -euo pipefail

if [ "${DROOG:-0}" = "1" ]; then
  # Droogloop: pct/pveam/pvesm alleen tonen. pct status moet 'niet bestaand'
  # teruggeven, anders denkt het script dat het nummer al in gebruik is.
  pct() { if [ "$1" = "status" ]; then return 1; fi; echo "   [droog] pct $*"; }
  pveam() {
    case "${1:-}" in
      available) echo "system          debian-13-standard_13.1-2_amd64.tar.zst" ;;
      list) : ;;
      *) echo "   [droog] pveam $*" ;;
    esac
  }
  pvesm() { echo "   [droog] pvesm $*"; }
fi
if [ "${DROOG:-0}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Draai dit als root op de Proxmox-host." >&2
  exit 1
fi
command -v pct >/dev/null 2>&1 || { echo "pct ontbreekt: dit moet op een Proxmox-host draaien, niet in een container." >&2; exit 1; }

HOSTNAAM="${HOSTNAAM:-werdens-monitor}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-2048}"
SWAP="${SWAP:-512}"
DISK="${DISK:-8}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"

zeg() { echo "→ $*"; }
doe() { if [ "${DROOG:-0}" = "1" ]; then echo "   [droog] $*"; else "$@"; fi; }

# Eerste vrije container-ID als er geen is opgegeven
if [ -z "${CTID:-}" ]; then
  CTID=120
  while pct status "$CTID" >/dev/null 2>&1; do CTID=$((CTID + 1)); done
fi
if pct status "$CTID" >/dev/null 2>&1; then
  echo "Container $CTID bestaat al. Kies een ander nummer met CTID=..." >&2
  exit 1
fi

# Opslag voor de rootfs automatisch kiezen
if [ -z "${STORAGE:-}" ]; then
  STORAGE="$(pvesm status --content images 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
  [ -n "$STORAGE" ] || STORAGE="local-lvm"
fi

# Template zoeken; ontbreekt hij, dan downloaden
TMPL_OPSLAG="$(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
[ -n "$TMPL_OPSLAG" ] || TMPL_OPSLAG="local"
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system 2>/dev/null | awk '{print $2}' | grep -E '^debian-1[23]-standard' | sort -V | tail -1 || true)"
if [ -z "$TEMPLATE" ]; then
  echo "Geen Debian-template gevonden. Draai eerst 'pveam update' op de host." >&2
  exit 1
fi
if ! pveam list "$TMPL_OPSLAG" 2>/dev/null | grep -q "$TEMPLATE"; then
  zeg "Template $TEMPLATE downloaden"
  doe pveam download "$TMPL_OPSLAG" "$TEMPLATE"
fi

if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "Zet ADMIN_PASSWORD; anders maakt de app er zelf één en moet je die uit het log vissen." >&2
  exit 1
fi

ROOT_WW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"

zeg "Container $CTID ($HOSTNAAM) aanmaken op $STORAGE"
doe pct create "$CTID" "$TMPL_OPSLAG:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAAM" \
  --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=$IP" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 \
  --password "$ROOT_WW" \
  --description "Werdens Monitor — infra- en websitedashboard (Werdens Media)"

doe pct start "$CTID"
zeg "Wachten tot de container op het netwerk is"
if [ "${DROOG:-0}" != "1" ]; then
  for _ in $(seq 1 60); do
    if pct exec "$CTID" -- ip -4 addr show eth0 2>/dev/null | grep -q 'inet '; then break; fi
    sleep 2
  done
  pct exec "$CTID" -- ip -4 addr show eth0 2>/dev/null | grep -q 'inet ' \
    || { echo "Container kwam niet op het netwerk. Controleer 'pct status $CTID' en de bridge." >&2; exit 1; }
fi

zeg "Basispakketten in de container installeren"
doe pct exec "$CTID" -- bash -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates' >/dev/null 2>&1 || true

zeg "Werdens Monitor installeren"
doe pct exec "$CTID" -- env \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  PORT=8080 \
  bash -c 'curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/installeer.sh | bash'

if [ "${DROOG:-0}" != "1" ]; then
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  echo "Klaar. Werdens Monitor draait in LXC $CTID op http://${CT_IP:-<ip>}:8080"
  echo "Root-wachtwoord van de container: $ROOT_WW"
  echo "Bijwerken: dit script opnieuw draaien met een bestaand CTID doet niets;"
  echo "gebruik dan: pct exec $CTID -- bash -c 'curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/installeer.sh | bash'"
else
  echo
  echo "[droog] Geen container aangemaakt."
fi
