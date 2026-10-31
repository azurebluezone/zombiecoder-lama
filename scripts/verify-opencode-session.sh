#!/usr/bin/env bash
# Prove the editor binding end to end:
#   opencode -> lama provider (OpenAI-compatible) -> manager :9934 -> engine :9931
#
#   ./scripts/verify-opencode-session.sh                 # expects "lama is alive"
#   ./scripts/verify-opencode-session.sh "say OK"        # custom expected text
#
# A real session is created and its answer is printed. `--standalone` starts a
# private OpenCode server so a background editor service cannot interfere.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${LAMA_OPENCODE_MODEL:-lama/llama-3-2-1b}"
AGENT="${LAMA_OPENCODE_AGENT:-lama-chat}"
EXPECT="${1:-lama is alive}"
LIMIT="${LAMA_OPENCODE_TIMEOUT:-180}"
OUT="$(mktemp)"

cd "$DIR"
if ! curl -fsS -m 5 http://127.0.0.1:9934/healthz >/dev/null 2>&1; then
  echo "FAIL: manager is not answering on 127.0.0.1:9934" >&2
  exit 1
fi

timeout "$LIMIT" opencode run --standalone --agent "$AGENT" --model "$MODEL" \
  "Reply with exactly: $EXPECT" >"$OUT" 2>&1 || true

if grep -qiF "$EXPECT" "$OUT"; then
  echo "opencode session PASS: $MODEL ($AGENT) answered \"$EXPECT\""
  echo "raw: $(grep -iF "$EXPECT" "$OUT" | tail -1)"
  rm -f "$OUT"
  exit 0
fi

echo "FAIL: no \"$EXPECT\" in the session output" >&2
tail -8 "$OUT" >&2
rm -f "$OUT"
exit 1
