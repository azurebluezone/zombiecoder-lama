#!/usr/bin/env bash
# Put one authenticated door in front of the manager, and leave the engine and
# the admin app unreachable from the network.
#
#   sudo ./scripts/install-nginx-proxy.sh                 # 0.0.0.0:8081
#   sudo LAMA_PROXY_LISTEN=127.0.0.1:8080 ./scripts/...   # loopback only
#   sudo ./scripts/install-nginx-proxy.sh --show-key      # print the token
#
# The token lives in /etc/nginx/lama.key (0600 root) and is rendered into the
# nginx config. Rotate it with: sudo rm /etc/nginx/lama.key && re-run this.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LISTEN="${LAMA_PROXY_LISTEN:-0.0.0.0:8081}"
KEY_FILE=/etc/nginx/lama.key
CONF=/etc/nginx/conf.d/lama.conf

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n "$0" "$@"
fi

if [ "${1:-}" = "--show-key" ]; then
  cat "$KEY_FILE"
  exit 0
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx is not installed: apt-get install -y nginx" >&2
  exit 1
fi

MGMT_PORT="$(sed -n 's/^LAMA_MGMT_PORT=//p' "$DIR/.env" 2>/dev/null | tail -1)"
MGMT_PORT="${MGMT_PORT:-9934}"

if [ ! -f "$KEY_FILE" ]; then
  umask 077
  openssl rand -hex 24 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "generated new key: $KEY_FILE"
fi
KEY="$(cat "$KEY_FILE")"

umask 077
sed -e "s|__LAMA_KEY__|$KEY|g" \
    -e "s|__LAMA_LISTEN__|$LISTEN|g" \
    -e "s|__LAMA_MGMT_PORT__|$MGMT_PORT|g" \
    "$DIR/deploy/nginx/lama.conf" > "$CONF"
chmod 600 "$CONF"

# The stock Ubuntu page is not part of this system.
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx

# A port already taken by something else makes nginx keep its old config
# silently; say it out loud instead of leaving a dead door.
PORT="${LISTEN##*:}"
if ! curl -fsS -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "FAIL: nothing answers on 127.0.0.1:$PORT/healthz — is the port taken?" >&2
  ss -ltnp 2>/dev/null | grep ":$PORT " >&2 || true
  exit 1
fi

echo "proxy:   http://$LISTEN -> 127.0.0.1:$MGMT_PORT"
echo "key:     $KEY_FILE (send: authorization: Bearer \$(cat $KEY_FILE))"
echo "check:   curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${LISTEN##*:}/healthz"
