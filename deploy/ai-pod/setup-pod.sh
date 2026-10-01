#!/usr/bin/env bash
# setup-pod.sh — bring ONE's inference pod (ADR-047) from a fresh start to a verified,
# key-protected OpenAI-compatible endpoint, idempotently.
#
# Why it exists: the RunPod pod has no persistent volume, so every stop wipes the virtualenv,
# the model and the server. This script is the one reproducible way back. Run it, as root, on
# the pod after every start (see deploy/ai-pod/README.md). Running it again on a pod that is
# already serving changes nothing and only re-runs the self-test.
#
# What it does, in order:
#   1. a virtualenv with the versions known to work on this pod (driver 570 / CUDA 12.8):
#      vllm==0.11.0, torch 2.8.0+cu128, transformers>=4.56,<4.58;
#   2. the model, Qwen/Qwen2.5-14B-Instruct (Apache-2.0), via huggingface_hub.snapshot_download;
#   3. the API key file, created only if missing (umask 077) — its value is never printed;
#   4. stops whatever listens on port 8888 (RunPod's JupyterLab), by PID;
#   5. starts `vllm serve` on 0.0.0.0:8888 under nohup, waits for /health;
#   6. self-test: no key -> 401, the key -> 200 with a real chat completion and token usage.
#
# It never prints the key, never puts it on a command line (so it is not visible in `ps`), and
# never contacts ONE. Nothing in ONE starts, stops or scales this pod.

set -euo pipefail

ONE_AI_HOME="${ONE_AI_HOME:-/root/one-ai}"
VENV="$ONE_AI_HOME/venv"
MODEL_REPO="${MODEL_REPO:-Qwen/Qwen2.5-14B-Instruct}"
MODEL_DIR="$ONE_AI_HOME/models/Qwen2.5-14B-Instruct"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-qwen2.5-14b-instruct}"
KEY_FILE="$ONE_AI_HOME/api-key"
LOG_FILE="$ONE_AI_HOME/vllm.log"
PID_FILE="$ONE_AI_HOME/vllm.pid"
PORT=8888
MAX_MODEL_LEN=16384
GPU_MEMORY_UTILIZATION=0.90
HEALTH_WAIT_SECONDS="${HEALTH_WAIT_SECONDS:-1200}"

VLLM_VERSION="0.11.0"
TORCH_VERSION="2.8.0"
TORCH_INDEX="https://download.pytorch.org/whl/cu128"
TRANSFORMERS_SPEC="transformers>=4.56,<4.58"

say() { printf '[setup-pod] %s\n' "$*"; }
fail() { printf '[setup-pod] FAILED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root on the pod"
command -v nvidia-smi >/dev/null || fail "nvidia-smi not found: this is not a GPU pod"
command -v curl >/dev/null || fail "curl is required"
mkdir -p "$ONE_AI_HOME/models"
chmod 700 "$ONE_AI_HOME"

# A temporary header file carries the key to curl (curl -H @file), so it never appears in argv.
HEADER_FILE=""
cleanup() { [ -n "$HEADER_FILE" ] && rm -f "$HEADER_FILE"; }
trap cleanup EXIT

# --------------------------------------------------------------------------------------------
# 1. Virtualenv with pinned versions
# --------------------------------------------------------------------------------------------
installed_ok() {
  [ -x "$VENV/bin/python" ] || return 1
  "$VENV/bin/python" - "$VLLM_VERSION" "$TORCH_VERSION" <<'PY' >/dev/null 2>&1
import sys
from importlib.metadata import version
want_vllm, want_torch = sys.argv[1], sys.argv[2]
assert version("vllm") == want_vllm
import torch
assert torch.__version__.split("+")[0] == want_torch and torch.version.cuda == "12.8"
major, minor = (int(part) for part in version("transformers").split(".")[:2])
assert (major, minor) >= (4, 56) and (major, minor) < (4, 58)
import huggingface_hub  # noqa: F401
PY
}

if installed_ok; then
  say "virtualenv already has vllm ${VLLM_VERSION}, torch ${TORCH_VERSION}+cu128 and a supported transformers"
else
  say "creating the virtualenv at $VENV (this downloads several GB)"
  command -v python3 >/dev/null || fail "python3 is required"
  python3 -m venv "$VENV" || fail "python3 -m venv failed; install python3-venv"
  "$VENV/bin/pip" install --quiet --upgrade pip
  # torch first from the CUDA 12.8 index, so vLLM does not pull a build for a newer driver.
  "$VENV/bin/pip" install --quiet "torch==${TORCH_VERSION}" --index-url "$TORCH_INDEX"
  "$VENV/bin/pip" install --quiet "vllm==${VLLM_VERSION}" "$TRANSFORMERS_SPEC" "huggingface_hub" \
    --extra-index-url "$TORCH_INDEX"
  installed_ok || fail "the virtualenv does not have the pinned versions (see the README's version notes)"
  say "virtualenv ready"
fi

# --------------------------------------------------------------------------------------------
# 2. Model weights
# --------------------------------------------------------------------------------------------
say "fetching $MODEL_REPO into $MODEL_DIR (skips files already present)"
"$VENV/bin/python" - "$MODEL_REPO" "$MODEL_DIR" <<'PY'
import sys
from huggingface_hub import snapshot_download
repo, target = sys.argv[1], sys.argv[2]
snapshot_download(
    repo_id=repo,
    local_dir=target,
    allow_patterns=["*.json", "*.safetensors", "*.txt", "tokenizer*", "vocab*", "merges*"],
)
PY
ls "$MODEL_DIR"/*.safetensors >/dev/null 2>&1 || fail "no weights in $MODEL_DIR"

# --------------------------------------------------------------------------------------------
# 3. API key (created once, never printed)
# --------------------------------------------------------------------------------------------
if [ -s "$KEY_FILE" ]; then
  say "API key file exists; keeping it"
else
  say "creating the API key file $KEY_FILE (mode 600; the value is not shown)"
  ( umask 077; "$VENV/bin/python" -c 'import secrets; print(secrets.token_urlsafe(48))' > "$KEY_FILE" )
fi
chmod 600 "$KEY_FILE"

HEADER_FILE="$(umask 077; mktemp "$ONE_AI_HOME/.auth-header.XXXXXX")"
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$KEY_FILE")" > "$HEADER_FILE"

serving_ok() {
  curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || return 1
  curl -fsS -m 10 -H @"$HEADER_FILE" "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null | grep -q "\"${SERVED_MODEL_NAME}\""
}

# --------------------------------------------------------------------------------------------
# 4 + 5. Free port 8888 and start vLLM (skipped when it is already serving this model)
# --------------------------------------------------------------------------------------------
listener_pids() {
  # PIDs listening on the port, from the socket table — not a process-name pattern, which could
  # match this script's own command line.
  if command -v ss >/dev/null; then
    ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v fuser >/dev/null; then
    fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u
  elif command -v lsof >/dev/null; then
    lsof -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | sort -u
  else
    fail "need ss, fuser or lsof to find what listens on port ${PORT}"
  fi
}

if serving_ok; then
  say "vLLM is already serving ${SERVED_MODEL_NAME} on port ${PORT}; not restarting"
else
  pids="$(listener_pids || true)"
  if [ -n "$pids" ]; then
    say "stopping the process(es) on port ${PORT} (PID ${pids//$'\n'/, })"
    for pid in $pids; do kill "$pid" 2>/dev/null || true; done
    for _ in $(seq 1 30); do [ -z "$(listener_pids || true)" ] && break; sleep 1; done
    for pid in $(listener_pids || true); do kill -9 "$pid" 2>/dev/null || true; done
    [ -z "$(listener_pids || true)" ] || fail "port ${PORT} is still in use"
  fi

  say "starting vLLM (${SERVED_MODEL_NAME}) on 0.0.0.0:${PORT}; log: $LOG_FILE"
  # VLLM_API_KEY is passed in the environment, not as --api-key, so it is not visible in `ps`.
  VLLM_API_KEY="$(tr -d '\r\n' < "$KEY_FILE")" nohup "$VENV/bin/vllm" serve "$MODEL_DIR" \
    --served-model-name "$SERVED_MODEL_NAME" \
    --host 0.0.0.0 --port "$PORT" \
    --max-model-len "$MAX_MODEL_LEN" \
    --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
    > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  say "waiting up to ${HEALTH_WAIT_SECONDS}s for /health (loading a 14B model takes minutes)"
  waited=0
  until curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; do
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null || fail "vLLM exited; see the last lines of $LOG_FILE"
    [ "$waited" -ge "$HEALTH_WAIT_SECONDS" ] && fail "vLLM did not become healthy in ${HEALTH_WAIT_SECONDS}s; see $LOG_FILE"
    sleep 10; waited=$((waited + 10))
  done
  say "vLLM is healthy"
fi

# --------------------------------------------------------------------------------------------
# 6. Self-test (prints status codes and token counts only)
# --------------------------------------------------------------------------------------------
no_key_status="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:${PORT}/v1/models")"
[ "$no_key_status" = "401" ] || fail "a request without the key returned ${no_key_status}, expected 401 — the endpoint is not protected"
say "self-test: no key -> 401"

body="$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with the single word: ready"}],"max_tokens":8,"temperature":0}' "$SERVED_MODEL_NAME")"
response_file="$(umask 077; mktemp "$ONE_AI_HOME/.selftest.XXXXXX")"
with_key_status="$(curl -s -o "$response_file" -w '%{http_code}' -m 120 -H @"$HEADER_FILE" -H 'Content-Type: application/json' \
  -d "$body" "http://127.0.0.1:${PORT}/v1/chat/completions")"
summary="$("$VENV/bin/python" - "$response_file" <<'PY' 2>/dev/null || true
import json, sys
data = json.load(open(sys.argv[1]))
usage = data.get("usage") or {}
text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
print(f"model={data.get('model')} prompt_tokens={usage.get('prompt_tokens')} completion_tokens={usage.get('completion_tokens')} answered={'yes' if text.strip() else 'no'}")
PY
)"
rm -f "$response_file"
[ "$with_key_status" = "200" ] || fail "a request with the key returned ${with_key_status}, expected 200"
say "self-test: key -> 200 (${summary})"

say "done. Endpoint for ONE: https://<this-pod-id>-${PORT}.proxy.runpod.net/v1  model: ${SERVED_MODEL_NAME}"
say "the key is in ${KEY_FILE}; copy it to the server .env as ONE_AI_API_KEY (README, step 4)"
