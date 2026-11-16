#!/usr/bin/env bash
#
# Diagnose the Mashov egress path from the backend host. Run it there:
#
#   PROXY_URL=http://<proxy-vpn-ip>:<port> bash ops/check-egress.sh
#
# Reads nothing privileged, changes nothing. See ADR-0023 for the design.
set -uo pipefail

PROXY_URL="${PROXY_URL:-${HTTPS_PROXY:-}}"
TARGET="${MASHOV_BASE_URL:-https://web.mashov.info}/api/schools"

probe() { curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" --max-time 20 "$@"; }

echo "== direct (no proxy)"
echo -n "   "; probe "$TARGET"
echo "   403 here is EXPECTED and healthy: Mashov blocks this host's IP,"
echo "   which is the entire reason the proxy exists."

echo
if [ -z "$PROXY_URL" ]; then
  echo "== no proxy configured"
  echo "   HTTPS_PROXY is unset and PROXY_URL was not passed. If the backend is"
  echo "   also running without HTTPS_PROXY, every Mashov call is getting a 403."
  exit 1
fi

host_port="${PROXY_URL#*://}"
host="${host_port%%:*}"
port="${host_port##*:}"

echo "== proxy reachable? ($host:$port)"
if timeout 3 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
  echo "   TCP open"
else
  rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "   TIMED OUT - the host is dropping packets rather than refusing them."
    echo "   This is the blackhole case: the proxy host is off the VPN entirely."
    echo "   Check VPN membership first; a lapsed node key looks exactly like this."
  else
    echo "   REFUSED - the host is up but nothing is listening on $port."
    echo "   The proxy service is down. Re-run ops/install-egress-proxy.sh."
  fi
  exit 1
fi

echo
echo "== through the proxy"
echo -n "   "; probe -x "$PROXY_URL" "$TARGET"
echo "   200 well under a second means egress is healthy."
echo "   403 means the proxy works but is egressing from a blocked IP."
