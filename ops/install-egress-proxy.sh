#!/usr/bin/env bash
#
# Install / repair the Mashov egress proxy.
#
# WHY THIS EXISTS
#   Mashov blocks the production server's datacenter IP: GET /api/schools returns
#   403 in ~110ms from the server and 200 in ~90ms from a residential IP. The
#   backend therefore sends every Mashov call through an HTTP proxy on a machine
#   with a residential address, configured via HTTPS_PROXY. See ADR-0023.
#
# WHERE IT RUNS
#   On the proxy host (a small always-on box on a residential connection),
#   reached over a private VPN. Run it from a workstation:
#
#     ALLOW_FROM=<backend-vpn-ip> ssh <user>@<proxy-host> 'bash -s' \
#       < ops/install-egress-proxy.sh
#
#   Then set HTTPS_PROXY=http://<proxy-vpn-ip>:<PROXY_PORT> on the backend.
#
# IDEMPOTENT: safe to re-run. Pass FORCE_CONF=1 to overwrite an existing config.
set -euo pipefail

PROXY_PORT="${PROXY_PORT:-8888}"
ALLOW_FROM="${ALLOW_FROM:-}"

if [ -z "$ALLOW_FROM" ]; then
  echo "ERROR: set ALLOW_FROM to the backend host's VPN address." >&2
  echo "       Leaving it unset would open the proxy to the whole VPN." >&2
  exit 2
fi

CONF=/etc/tinyproxy/tinyproxy.conf

echo "== installing tinyproxy (port $PROXY_PORT, allow $ALLOW_FROM)"
sudo apt-get update -qq
sudo apt-get install -y tinyproxy

if [ -f "$CONF" ] && [ ! -f "$CONF.orig" ]; then
  sudo cp "$CONF" "$CONF.orig"
  echo "   original config saved to $CONF.orig"
fi

echo "== writing config"
sudo tee "$CONF" >/dev/null <<CONF
# Managed by ops/install-egress-proxy.sh - see ADR-0023.
#
# Listen on all interfaces and restrict by ACL rather than binding to the VPN
# address directly. Binding to the VPN address looks tighter but fails closed in
# the worst way: on boot tinyproxy races the VPN daemon for the interface, and if
# the address is not up yet it exits 71/OSERR and stays dead. That is exactly how
# a lapsed VPN key became a 49-day outage once already.
User tinyproxy
Group tinyproxy
Port $PROXY_PORT
Listen 0.0.0.0
Timeout 600
MaxClients 50
StartServers 2
LogLevel Warning
PidFile "/run/tinyproxy/tinyproxy.pid"

# Only the backend host. Other machines on the VPN have no business here.
Allow 127.0.0.1
Allow $ALLOW_FROM

# Required for HTTPS: without these, CONNECT to :443 is refused.
ConnectPort 443
ConnectPort 563
CONF

echo "== restart policy"
# systemctl enable alone only covers a clean boot. Without Restart=, a transient
# bind failure leaves the proxy down until a human notices - and nothing here is
# monitored, so "until a human notices" has historically meant weeks.
sudo mkdir -p /etc/systemd/system/tinyproxy.service.d
sudo tee /etc/systemd/system/tinyproxy.service.d/restart.conf >/dev/null <<'UNIT'
[Service]
Restart=on-failure
RestartSec=10
UNIT

sudo systemctl daemon-reload
sudo systemctl enable tinyproxy
sudo systemctl restart tinyproxy
sleep 1

echo "== state"
echo "   enabled: $(systemctl is-enabled tinyproxy)"
echo "   active:  $(systemctl is-active tinyproxy)"
sudo ss -tlnp | grep -E ":$PROXY_PORT " || { echo "   NOT LISTENING"; exit 1; }

echo "== Mashov through the proxy (expect 200)"
curl -s -o /dev/null -w "   %{http_code}  %{time_total}s\n" --max-time 15 \
  -x "http://127.0.0.1:$PROXY_PORT" https://web.mashov.info/api/schools

cat <<'NEXT'

Next: from the backend host, confirm the proxy is reachable over the VPN:
  curl -s -o /dev/null -w "%{http_code} %{time_total}\n" --max-time 20 \
    -x http://<proxy-vpn-ip>:<port> https://web.mashov.info/api/schools
A 200 well under a second means egress is healthy.
NEXT
