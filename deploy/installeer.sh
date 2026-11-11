#!/usr/bin/env bash
# Werdens Monitor installeren of bijwerken op een Debian/Ubuntu-host of LXC.
#
#   curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/installeer.sh | bash
#
# Variabelen (vooraf zetten of als omgevingsvariabele meegeven):
#   ADMIN_PASSWORD  verplicht bij een verse installatie
#   GITHUB_TOKEN    token voor de Projecten-tab
#   PORT            standaard 8080
#   MAP             installatiemap, standaard /opt/werdens-monitor
set -euo pipefail

REPO="https://github.com/Theberas04/werdens-monitor.git"
MAP="${MAP:-/opt/werdens-monitor}"
DIENST="werdens-monitor"
POORT="${PORT:-8080}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Draai dit als root (of met sudo)." >&2
  exit 1
fi

# Node 22.5+ heeft node:sqlite nodig; ouder werkt niet. Ontbreekt Node, dan
# installeren we versie 22 via NodeSource. Een repo die niet bereikbaar is —
# bijvoorbeeld de Proxmox-enterprise-repo zonder abonnement, die 401 geeft —
# mag dat niet tegenhouden: apt-fouten worden genegeerd en daarna gecontroleerd.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -p 'Number(process.versions.node.split(".")[0])*100+Number(process.versions.node.split(".")[1])' 2>/dev/null)" -ge 2205 ]
}

apt_bij() { apt-get update -qq 2>/dev/null || true; }

installeer_node() {
  if command -v apt-get >/dev/null 2>&1; then
    apt_bij
    apt-get install -y -qq curl ca-certificates gnupg 2>/dev/null || true
    curl -fsSL https://deb.nodesource.com/setup_22.x 2>/dev/null | bash - >/dev/null 2>&1 || true
    apt_bij
    apt-get install -y -qq nodejs 2>/dev/null || true
    node_ok && return 0
  fi
  # Terugval zonder apt: de officiële tarball van nodejs.org.
  local arch versie url
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  versie="$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null | grep -oE '"version":"v22\.[0-9]+\.[0-9]+"' | head -1 | cut -d'"' -f4)"
  [ -n "$versie" ] || return 1
  url="https://nodejs.org/dist/$versie/node-$versie-linux-$arch.tar.gz"
  curl -fsSL "$url" -o /tmp/node-22.tar.gz 2>/dev/null || return 1
  mkdir -p /usr/local/lib/nodejs
  tar -xzf /tmp/node-22.tar.gz -C /usr/local/lib/nodejs --strip-components=1 2>/dev/null || return 1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm 2>/dev/null || true
  ln -sf /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx 2>/dev/null || true
  hash -r 2>/dev/null || true
  node_ok
}

if ! node_ok; then
  echo "Node 22.5+ ontbreekt of is te oud; Node 22 wordt geïnstalleerd." >&2
  if ! installeer_node; then
    echo "Node 22.5 of nieuwer installeren is niet gelukt. Installeer Node 22 (bijv. via https://deb.nodesource.com/setup_22.x) en probeer opnieuw." >&2
    exit 1
  fi
fi
echo "Node $(node -v) gevonden."

if ! command -v git >/dev/null 2>&1; then
  apt_bij
  apt-get install -y -qq git ca-certificates 2>/dev/null || true
  command -v git >/dev/null 2>&1 || { echo "git ontbreekt en kon niet geïnstalleerd worden." >&2; exit 1; }
fi

if [ -d "$MAP/.git" ]; then
  echo "Bijwerken in $MAP"
  git -C "$MAP" fetch --quiet origin main
  git -C "$MAP" reset --hard --quiet origin/main
else
  echo "Installeren in $MAP"
  git clone --quiet --depth 1 "$REPO" "$MAP"
fi

cd "$MAP"
mkdir -p data

if [ -z "${ADMIN_PASSWORD:-}" ] && [ ! -f data/.wachtwoord ]; then
  echo "Let op: ADMIN_PASSWORD is niet gezet; de app genereert er één en zet die in het log." >&2
  echo "Lees hem met: journalctl -u $DIENST -n 40 | grep -i wachtwoord" >&2
fi

# Systeemgebruiker zonder login-rechten
if ! id -u werdens >/dev/null 2>&1; then
  useradd --system --home "$MAP" --shell /usr/sbin/nologin werdens
fi
chown -R werdens:werdens "$MAP/data"

# Omgevingsbestand met de geheimen (alleen voor root en de dienst leesbaar)
if [ ! -f /etc/$DIENST.env ]; then
  {
    echo "PORT=$POORT"
    echo "DB_PATH=$MAP/data/monitor.db"
    [ -n "${ADMIN_PASSWORD:-}" ] && echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
    [ -n "${ADMIN_NAAM:-}" ] && echo "ADMIN_NAAM=$ADMIN_NAAM"
    [ -n "${GITHUB_TOKEN:-}" ] && echo "GITHUB_TOKEN=$GITHUB_TOKEN"
  } > "/etc/$DIENST.env"
  chmod 600 "/etc/$DIENST.env"
else
  echo "/etc/$DIENST.env bestaat al; laat ongemoeid."
fi

cat > "/etc/systemd/system/$DIENST.service" <<DIENSTBESTAND
[Unit]
Description=Werdens Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=werdens
WorkingDirectory=$MAP
EnvironmentFile=/etc/$DIENST.env
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$MAP/data

[Install]
WantedBy=multi-user.target
DIENSTBESTAND

systemctl daemon-reload
systemctl enable --now "$DIENST" >/dev/null
sleep 2
systemctl is-active --quiet "$DIENST" || { journalctl -u "$DIENST" -n 30 --no-pager; exit 1; }

if command -v curl >/dev/null 2>&1; then
  STATUS="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$POORT/healthz" || true)"
  echo "Gezondheid: $STATUS"
fi

echo
echo "Werdens Monitor draait op poort $POORT — http://$(hostname -I | awk '{print $1}'):$POORT"
echo "Bijwerken: dit script opnieuw draaien. Logboek: journalctl -u $DIENST -f"
