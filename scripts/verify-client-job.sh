#!/usr/bin/env bash
# One real task through every client surface, then one machine-checkable line.
#
#   MCP stdio read  -> manager TCP -> manager Anthropic -> manager SSE
#   -> engine TCP   -> engine UDS  -> MCP stdio write
#
# Needs: lama-engine + lama-mgmt running, a loaded model, workspace/facts.txt.
# The summary line is the evidence; the report it wrote is printed after it.
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT="${LAMA_CLIENT:-$DIR/examples/python/lama_client.py}"
REPORT="$DIR/workspace/report.txt"
ERR="$(mktemp)"
OUT="$(mktemp)"

rm -f "$REPORT"

LAMA_MCP_TOOLS="${LAMA_MCP_TOOLS:-read_file}" LAMA_TOOLS_ALLOW_WRITE=1 \
  python3 "$CLIENT" job >"$OUT" 2>"$ERR"
rc=$?

python3 - "$ERR" "$OUT" "$REPORT" "$rc" <<'PY'
import os
import re
import sys

err_path, _out_path, report_path, rc = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
err = open(err_path, encoding="utf-8", errors="replace").read()

# Only HTTP stages carry a status code; the two MCP steps are checked by name.
stages = re.findall(r"^\[(tcp|anthropic|sse|engine|uds)\] (\d{3})", err, re.M)
codes = [code for _, code in stages]
mcp_read = "[mcp] read facts.txt" in err
mcp_write = "[mcp] wrote report.txt" in err

tcp = ""
for line in err.splitlines():
    if line.startswith("[tcp] "):
        tcp = line.split(" ", 2)[2]
        break

report = open(report_path, encoding="utf-8").read() if os.path.exists(report_path) else ""
model_line = ""
for line in report.splitlines():
    if line.startswith("- model line:"):
        model_line = line.split(":", 1)[1].strip()
        break

ok = (
    rc == 0
    and len(codes) == 5
    and all(code == "200" for code in codes)
    and mcp_read
    and mcp_write
    and model_line == tcp
    and "CODENAME=neel PORT=4242" in tcp
)

print(
    "stages=%d codes=%s mcp_read=%s mcp_write=%s tcp=%s modelline=%s report_bytes=%d exit=%d %s"
    % (
        len(codes),
        ",".join(codes),
        "yes" if mcp_read else "no",
        "yes" if mcp_write else "no",
        tcp,
        model_line,
        len(report.encode()),
        rc,
        "OK" if ok else "FAIL",
    )
)
sys.exit(0 if ok else 1)
PY
status=$?

cat "$OUT"
rm -f "$ERR" "$OUT"
exit "$status"
