#!/usr/bin/env bash
# install-from-git.sh — bring lama up on a fresh OS from the git repository.
#
# What it does, in order:
#   1. clone (or fast-forward) the repo into $LAMA_DIR
#   2. back up the old .env, then write a fresh one from templates/env.template,
#      keeping the old API/admin/HF tokens
#   3. npm ci
#   4. install the stock llama.cpp binary when it is missing (node src/main.ts install)
#   5. install and start the three resident units: engine, manager, status.
#      The admin unit is never enabled — it stays an on-demand client.
#   6. verify /healthz on the manager and the status file
#
# The admin app is optional. Nothing here needs it to run the engine.
#
# Usage:
#   ./scripts/install-from-git.sh                 # install/update in $HOME/lama
#   ./scripts/install-from-git.sh --dir /opt/lama --ref main
#   ./scripts/install-from-git.sh --dry-run       # print the plan, change nothing
#   ./scripts/install-from-git.sh --force         # discard local changes in the repo
#   ./scripts/install-from-git.sh --with-admin    # write the admin unit (never enabled)
#   ./scripts/install-from-git.sh --skip-llama    # keep the existing llama.cpp binary
#   ./scripts/install-from-git.sh --with-proxy    # also put nginx in front (needs root)
#
# Environment: LAMA_REPO, LAMA_DIR, LAMA_REF
# Exit codes: 0 ok, 1 failed, 2 usage/missing prerequisite.

set -euo pipefail

REPO="${LAMA_REPO:-https://github.com/azurebluezone/zombiecoder-lama.git}"
DIR="${LAMA_DIR:-$HOME/lama}"
REF="${LAMA_REF:-main}"
WITH_ADMIN=0
DRY_RUN=0
FORCE=0
SKIP_LLAMA=0
WITH_PROXY=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run()  {
  if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --with-admin) WITH_ADMIN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-llama) SKIP_LLAMA=1; shift ;;
    --with-proxy) WITH_PROXY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) say "unknown option: $1"; usage; exit 2 ;;
  esac
done

step "prerequisites"
for tool in git node npm curl; do
  command -v "$tool" >/dev/null 2>&1 || { say "missing: $tool"; exit 2; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { say "node >= 22 is required (found $(node -v)); the repo runs TypeScript directly"; exit 2; }
say "node $(node -v), git $(git --version | awk '{print $3}'), dir $DIR, ref $REF"

step "repository"
if [ -d "$DIR/.git" ]; then
  if [ "$DRY_RUN" = 0 ] && [ -n "$(git -C "$DIR" status --porcelain)" ] && [ "$FORCE" = 0 ]; then
    say "local changes in $DIR; commit/stash them, or pass --force to discard"
    exit 1
  fi
  run git -C "$DIR" fetch --depth 1 origin "$REF"
  if [ "$FORCE" = 1 ]; then
    run git -C "$DIR" reset --hard FETCH_HEAD
  else
    run git -C "$DIR" merge --ff-only FETCH_HEAD
  fi
else
  run mkdir -p "$(dirname "$DIR")"
  run git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

step "configuration"
ENV_FILE="$DIR/.env"
OLD_ENV="$ENV_FILE"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -f "$OLD_ENV" ] && [ "$DRY_RUN" = 0 ]; then
  cp -p "$OLD_ENV" "$ENV_FILE.bak.$STAMP"
  say "backup: $ENV_FILE.bak.$STAMP"
fi
keep() { # keep KEY from the old env when present
  [ -f "$OLD_ENV" ] || return 0
  sed -n "s/^$1=//p" "$OLD_ENV" | tail -1
}
OLD_API_KEY="$(keep LAMA_API_KEY || true)"
OLD_ADMIN_TOKEN="$(keep LAMA_ADMIN_TOKEN || true)"
OLD_HF_TOKEN="$(keep HF_TOKEN || true)"
[ -n "$OLD_API_KEY" ] || OLD_API_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
[ -n "$OLD_ADMIN_TOKEN" ] || OLD_ADMIN_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"

if [ "$DRY_RUN" = 0 ]; then
  LLAMA_BIN_PATH="$(command -v llama-server || true)"
  LLAMA_BIN_PATH="${LLAMA_BIN_PATH:-$DIR/bin/llama-server}"
  sed -e "s|{{LLAMA_BIN}}|$LLAMA_BIN_PATH|g" -e "s|{{LAMA_DIR}}|$DIR|g" \
    "$DIR/templates/env.template" > "$ENV_FILE"
  # put the kept secrets back without printing them
  python3 - "$ENV_FILE" "$OLD_API_KEY" "$OLD_ADMIN_TOKEN" "$OLD_HF_TOKEN" <<'PY'
import sys
path, api, admin, hf = sys.argv[1:5]
lines = open(path, encoding="utf-8").read().splitlines()
out = []
for line in lines:
    if line.startswith("LAMA_API_KEY="):
        out.append(f"LAMA_API_KEY={api}")
    elif line.startswith("LAMA_ADMIN_TOKEN="):
        out.append(f"LAMA_ADMIN_TOKEN={admin}")
    elif line.startswith("HF_TOKEN="):
        out.append(f"HF_TOKEN={hf}")
    else:
        out.append(line)
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
  chmod 600 "$ENV_FILE"
  say "wrote $ENV_FILE (mode 600), tokens preserved"
fi

step "dependencies"
run mkdir -p "$DIR/models" "$DIR/logs" "$DIR/data" "$DIR/workspace" "$DIR/run"
if [ -f "$DIR/package-lock.json" ]; then
  run npm --prefix "$DIR" ci --no-audit --no-fund
else
  run npm --prefix "$DIR" install --no-audit --no-fund
fi

step "llama.cpp binary"
if [ "$SKIP_LLAMA" = 1 ]; then
  say "skipped (--skip-llama)"
elif command -v llama-server >/dev/null 2>&1; then
  say "found $(command -v llama-server)"
elif [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] node src/main.ts install"
else
  ( cd "$DIR" && node src/main.ts install )
fi

step "services"
# Ownership rules enforced here, on every install and every update:
#   - lama-engine.service owns the engine process (the admin never spawns it)
#   - lama-mgmt.service and lama-status.service are resident
#   - lama-admin is an on-demand client: its unit is never enabled by an install
# This is why an old machine that had lama-admin enabled gets it disabled below.
OS_NAME="$(uname -s)"
HAVE_SYSTEMD=0
if [ "$OS_NAME" = "Linux" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  HAVE_SYSTEMD=1
fi

unit_of() { case "$1" in manager) printf 'lama-mgmt' ;; *) printf 'lama-%s' "$1" ;; esac; }

admin_state() {
  if [ "$HAVE_SYSTEMD" = 1 ]; then
    printf '%s/%s' "$(systemctl --user is-enabled lama-admin.service 2>/dev/null || true)" "$(systemctl --user is-active lama-admin.service 2>/dev/null || true)"
  elif [ "$OS_NAME" = "Darwin" ]; then
    if [ -f "$HOME/Library/LaunchAgents/com.lama.lama-admin.plist" ]; then printf 'installed'; else printf 'absent'; fi
  else
    printf 'unknown'
  fi
}

if [ "$HAVE_SYSTEMD" = 1 ]; then
  # A legacy install may still have the admin enabled and running. Stop it before
  # anything else so the engine it owns can be handed to lama-engine.service.
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] systemctl --user disable --now lama-admin.service (if present)"
  else
    systemctl --user disable --now lama-admin.service >/dev/null 2>&1 || true
    systemctl --user reset-failed lama-admin.service >/dev/null 2>&1 || true
    say "admin unit: $(admin_state)"
  fi
  for kind in engine manager status; do
    run node "$DIR/src/main.ts" service install user --kind "$kind" --start
  done
  if [ "$WITH_ADMIN" = 1 ]; then
    run node "$DIR/src/main.ts" service install user --kind admin --no-start
    say "admin unit installed but NOT enabled; start it when you want it: systemctl --user start lama-admin"
  else
    say "admin unit not installed (on-demand only; pass --with-admin to write the file)"
  fi
elif [ "$OS_NAME" = "Darwin" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] launchctl bootout gui/$(id -u)/com.lama.lama-admin (if present)"
  else
    launchctl bootout "gui/$(id -u)/com.lama.lama-admin" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/com.lama.lama-admin.plist"
  fi
  for kind in engine manager status; do
    run node "$DIR/src/main.ts" service install user --kind "$kind"
  done
  if [ "$WITH_ADMIN" = 1 ]; then
    run node "$DIR/src/main.ts" service install user --kind admin --no-start
    say "admin plist installed but not loaded; start it with: npm start"
  else
    say "admin plist not installed (on-demand only)"
  fi
else
  say "no systemd/launchd detected; start the three resident processes yourself:"
  say "  (cd $DIR && node src/main.ts engine-run)   # engine supervisor"
  say "  (cd $DIR && node server/server.mjs)        # manager  :9934"
  say "  (cd $DIR && node server/status.mjs)        # status   :9935"
  say "  admin: (cd $DIR && npm start) — only while you want it"
fi

step "network door"
if [ "$WITH_PROXY" = 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] sudo $DIR/scripts/install-nginx-proxy.sh"
  elif sudo -n "$DIR/scripts/install-nginx-proxy.sh"; then
    say "nginx door installed; key: /etc/nginx/lama.key"
  else
    say "proxy install failed (needs nginx + passwordless sudo); run it yourself:"
    say "  sudo $DIR/scripts/install-nginx-proxy.sh"
  fi
else
  say "network door not installed (manager stays on 127.0.0.1). To publish it:"
  say "  sudo $DIR/scripts/install-nginx-proxy.sh"
fi

step "verify"
if [ "$DRY_RUN" = 1 ]; then say "[dry-run] skip health checks"; exit 0; fi

# Print what is asserted, so the recorded output is evidence by itself.
if [ "$HAVE_SYSTEMD" = 1 ]; then
  for kind in engine manager status admin; do
    unit="$(unit_of "$kind")"
    printf 'unit %-7s (%s) enabled=%-8s active=%s\n' "$kind" "$unit" \
      "$(systemctl --user is-enabled "$unit.service" 2>/dev/null || true)" \
      "$(systemctl --user is-active "$unit.service" 2>/dev/null || true)"
  done
  if [ "$WITH_ADMIN" = 0 ] && [ "$(systemctl --user is-active lama-admin.service 2>/dev/null || true)" = "active" ]; then
    say "FAIL: lama-admin is active; the admin must stay on-demand"
    exit 1
  fi
fi

MGMT_PORT="$(sed -n 's/^LAMA_MGMT_PORT=//p' "$DIR/.env" | tail -1)"
STATUS_PORT="$(sed -n 's/^LAMA_STATUS_PORT=//p' "$DIR/.env" | tail -1)"
MGMT_PORT="${MGMT_PORT:-9934}"
STATUS_PORT="${STATUS_PORT:-9935}"

ok=0
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:$MGMT_PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then
  say "manager /healthz: ok (:$MGMT_PORT)"
else
  say "manager /healthz: not up yet — check: journalctl --user -u lama-mgmt -n 40"
fi
if curl -fsS -m 2 "http://127.0.0.1:$STATUS_PORT/status.json" >/dev/null 2>&1; then
  say "status /status.json: ok (:$STATUS_PORT)"
else
  say "status: not up — check: journalctl --user -u lama-status -n 40"
fi
say ""
say "engine   lama-engine.service (stock llama.cpp, :9931 + Unix socket)"
say "manager  http://127.0.0.1:$MGMT_PORT/healthz"
say "status   http://127.0.0.1:$STATUS_PORT/status.json"
say "admin    on-demand only: npm start (no unit enabled)"
