#!/usr/bin/env bash
# Verifies that app.env is ready for NODE_ENV=production before a release is built.
#
# Production startup hard-fails on missing Cognito or automation secrets, so this
# turns a would-be outage at switch time into a named list of missing lines before
# any build starts. It checks and reports; it never writes app.env, because that
# file is the operator's.
set -euo pipefail

APP_ENV=${1:-/srv/planthepath-next/shared/app.env}
MISSING=()

need() { # key, description
  local key=$1 description=$2 value
  value=$(grep -s "^${key}=" "${APP_ENV}" | tail -n 1 | cut -d= -f2- || true)
  if [ -z "${value}" ]; then MISSING+=("${key}|${description}"); fi
}

[ -f "${APP_ENV}" ] || { echo "app.env not found at ${APP_ENV}" >&2; exit 1; }

# What loadRuntimeConfig refuses to start without in production.
need NODE_ENV "must be exactly: production"
need COGNITO_USER_POOL_ID "server-side pool id, e.g. ap-south-1_nPl3qFkvB (the VITE_ variant is the browser's, not the API's)"
need COGNITO_CLIENT_ID "server-side app client id (the VITE_ variant is the browser's, not the API's)"
need AUTOMATION_SIGNING_SECRET "at least 32 bytes; generate with: openssl rand -base64 48"

NODE_ENV_VALUE=$(grep -s '^NODE_ENV=' "${APP_ENV}" | tail -n 1 | cut -d= -f2- || true)
if [ -n "${NODE_ENV_VALUE}" ] && [ "${NODE_ENV_VALUE}" != "production" ]; then
  MISSING+=("NODE_ENV|currently '${NODE_ENV_VALUE}', must be: production")
fi

SECRET=$(grep -s '^AUTOMATION_SIGNING_SECRET=' "${APP_ENV}" | tail -n 1 | cut -d= -f2- || true)
if [ -n "${SECRET}" ] && [ "${#SECRET}" -lt 32 ]; then
  MISSING+=("AUTOMATION_SIGNING_SECRET|present but shorter than 32 bytes")
fi

# Production refuses plaintext document storage: a storage root demands a key.
STORAGE_ROOT_VALUE=$(grep -s '^FILE_STORAGE_ROOT=' "${APP_ENV}" | tail -n 1 | cut -d= -f2- || true)
FILE_KEY_VALUE=$(grep -s '^FILE_ENCRYPTION_KEY=' "${APP_ENV}" | tail -n 1 | cut -d= -f2- || true)
if [ -n "${STORAGE_ROOT_VALUE}" ] && [ -z "${FILE_KEY_VALUE}" ]; then
  MISSING+=("FILE_ENCRYPTION_KEY|required when FILE_STORAGE_ROOT is set; generate with: openssl rand -base64 32")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "app.env is not ready for production mode. Add or fix these lines in ${APP_ENV}:" >&2
  for entry in "${MISSING[@]}"; do
    printf '  %-28s %s\n' "${entry%%|*}" "${entry#*|}" >&2
  done
  exit 2
fi

echo "preflight: app.env satisfies production-mode startup requirements"
