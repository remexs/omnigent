#!/usr/bin/env bash
# Patch host containers to avoid the host 0.8.2 readiness-probe stall.
#
# Symptom: host logs show `codex_native_app_server ... native-codex routing`
# every ~60s; each probe blocks the tunnel event loop (~60s on a slow
# gateway), the server's ping times out and recycles the tunnel, and the
# host ends up wedged on a half-open connection that never processes
# launch_runner frames.
#
# Fix applied (two edits inside the container's site-packages):
#   1. skip the codex provider probe in `_harness_availability`
#      (readiness reports "binary-missing" instantly instead of probing),
#   2. slow the readiness refresh loops (quick 5s -> 300s, full 60s -> 3600s)
#      so the tunnel's recv loop is never starved by repeated probes.
#
# Usage: patch-host-readiness.sh [host-container ...]
#   default: all running omnigent-host-* containers
set -euo pipefail

HOSTS=("$@")
if [ ${#HOSTS[@]} -eq 0 ]; then
  HOSTS=($(docker ps --format '{{.Names}}' | grep '^omnigent-host-' || true))
fi

PATCH_PY=$(cat <<'PYEOF'
import pathlib

connect = pathlib.Path("/opt/venv/lib/python3.12/site-packages/omnigent/host/connect.py")
s = connect.read_text()
old = "HARNESS_READINESS_REFRESH_INTERVAL_S = 5.0"
if old not in s:
    raise SystemExit("connect.py refresh interval not found — already patched?")
s = s.replace(old, "HARNESS_READINESS_REFRESH_INTERVAL_S = 300.0")
old2 = "HARNESS_READINESS_FULL_REFRESH_INTERVAL_S = 60.0"
assert old2 in s
s = s.replace(old2, "HARNESS_READINESS_FULL_REFRESH_INTERVAL_S = 3600.0")
connect.write_text(s)

readiness = pathlib.Path(
    "/opt/venv/lib/python3.12/site-packages/omnigent/onboarding/harness_readiness.py"
)
s2 = readiness.read_text()
old3 = """    if _is_codex_family_harness(canonical):
        from omnigent.codex_native import _codex_auth_unavailable_reason

        return _codex_auth_unavailable_reason() or True"""
if old3 not in s2:
    raise SystemExit("harness_readiness.py codex block not found — already patched?")
new3 = """    if _is_codex_family_harness(canonical):
        # Fast path: skip the provider probe (can block ~60s per call on a
        # slow gateway), which would stall the host tunnel event loop.
        return "binary-missing" """
s2 = s2.replace(old3, new3)
readiness.write_text(s2)

for cache in (
    pathlib.Path("/opt/venv/lib/python3.12/site-packages/omnigent/host/__pycache__"),
    pathlib.Path("/opt/venv/lib/python3.12/site-packages/omnigent/onboarding/__pycache__"),
):
    if cache.exists():
        import shutil
        shutil.rmtree(cache)
print("readiness patch applied")
PYEOF
)

for host in "${HOSTS[@]}"; do
  echo "== patching $host =="
  docker cp /dev/stdin "$host:/tmp/_readiness_patch.py" <<< "$PATCH_PY"
  docker exec "$host" python3 /tmp/_readiness_patch.py || echo "  patch failed for $host"
  docker restart "$host" >/dev/null
  echo "  $host restarted"
done
echo "done. verify: docker logs omnigent-host-<name> | grep codex_native_app_server (should be gone)"
