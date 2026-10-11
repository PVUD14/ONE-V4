#!/usr/bin/env bash
# One command for the code sandbox attack suite (ENG-12): starts the sandbox from
# deploy/sandbox/docker-compose.yml in local Docker, installs the Python runtime through the install
# overlay (the only time Piston has an outbound route), brings it back up without that route, checks
# that the Piston container itself has no egress, and runs attacks.mjs against the proxy.
#
# Why this exists: the attack suite must be runnable by anyone with Docker, with nothing to set up by
# hand, so an image bump or a config change can be checked before it reaches the VM.
#
#   bash deploy/sandbox/attack-suite/run.sh          # leaves the sandbox running (for the C8 test)
#   KEEP=0 bash deploy/sandbox/attack-suite/run.sh   # tears it down afterwards
#
# Needs: Docker with cgroup v2 (Docker Desktop on WSL2 works; Piston needs --privileged), Node 18+.
# Prints PISTON_URL / PISTON_TOKEN to use with the C8 test. The token is a throwaway local value.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "$HERE/.." && pwd)"
PROJECT="${SANDBOX_PROJECT:-one-sandbox-local}"
export SANDBOX_PORT="${SANDBOX_PORT:-2000}"
export SANDBOX_BIND=127.0.0.1
export SANDBOX_TOKEN="${SANDBOX_TOKEN:-local-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
PYTHON_VERSION="${SANDBOX_PYTHON_VERSION:-3.12.0}"
URL="http://127.0.0.1:${SANDBOX_PORT}"
compose() { docker compose -p "$PROJECT" -f "$SANDBOX_DIR/docker-compose.yml" "$@"; }

echo "== starting the sandbox with the install route"
compose -f "$SANDBOX_DIR/docker-compose.install.yml" up -d --wait >/dev/null
echo "== installing python $PYTHON_VERSION (inside the container; the proxy does not forward package routes)"
compose exec -T piston node -e "
const body = JSON.stringify({ language: 'python', version: process.argv[1] });
const request = require('http').request({ host: '127.0.0.1', port: 2000, path: '/api/v2/packages', method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
  let text = ''; response.on('data', (chunk) => { text += chunk; });
  response.on('end', () => { const ok = response.statusCode === 200 || /already installed/i.test(text); console.log(ok ? 'installed' : 'install failed: ' + response.statusCode); process.exit(ok ? 0 : 1); });
});
request.end(body);" "$PYTHON_VERSION"

echo "== restarting without the install route"
compose up -d --wait --remove-orphans >/dev/null
for _ in $(seq 1 30); do
  curl -fsS -H "authorization: Bearer $SANDBOX_TOKEN" "$URL/api/v2/runtimes" >/dev/null 2>&1 && break
  sleep 1
done

echo "== the Piston container itself has no outbound route"
EGRESS=$(compose exec -T piston node -e "
const socket = require('net').connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
socket.on('connect', () => { console.log('OPEN'); process.exit(0); });
socket.on('error', (error) => { console.log('BLOCKED ' + error.code); process.exit(0); });
socket.on('timeout', () => { console.log('BLOCKED timeout'); process.exit(0); });")
echo "   container egress to 1.1.1.1:443: $EGRESS"

status=0
SANDBOX_URL="$URL" SANDBOX_PYTHON_VERSION="$PYTHON_VERSION" node "$HERE/attacks.mjs" || status=$?
case "$EGRESS" in BLOCKED*) ;; *) echo "FAIL  the Piston container can reach the internet"; status=1;; esac

if [ "${KEEP:-1}" = "0" ]; then
  compose down -v >/dev/null
else
  echo
  echo "Sandbox left running for the C8 test:"
  echo "  PISTON_URL=$URL PISTON_TOKEN=$SANDBOX_TOKEN"
  echo "Stop it with: docker compose -p $PROJECT -f deploy/sandbox/docker-compose.yml down -v"
fi
exit $status
