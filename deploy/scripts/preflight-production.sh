#!/usr/bin/env bash
# Verifies that app.env is ready for NODE_ENV=production before a release is built.
#
# Production startup hard-fails on missing Cognito or automation secrets, so this
# turns a would-be outage at switch time into a named list of missing lines before
# any build starts. It checks and reports; it never writes app.env, because that
# file is the operator's.
#
# Staff pool (ADR-025, OPS-07). Usage:
#   preflight-production.sh [APP_ENV] [--require-staff-pool]
# A half-configured staff pool always fails, because the API refuses to start with one.
# A missing staff pool is a named warning by default -- production runs without one
# until Divakar creates it (docs/ops/runbook-staff-pool.md) -- and a failure with
# --require-staff-pool, which is how the security go-live release is checked.
# Only setting names are ever printed, never their values.
set -euo pipefail

APP_ENV=/srv/planthepath-next/shared/app.env
REQUIRE_STAFF_POOL=0
for arg in "$@"; do
  case "${arg}" in
    --require-staff-pool) REQUIRE_STAFF_POOL=1 ;;
    -*) echo "unknown option: ${arg}" >&2; exit 64 ;;
    *) APP_ENV=${arg} ;;
  esac
done
MISSING=()
WARNINGS=()

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

# ADR-025 staff pool. Mirrors parseStaffPool in apps/api/src/config.ts.
value_of() { grep -s "^$1=" "${APP_ENV}" | tail -n 1 | cut -d= -f2- || true; }
POOL_ID_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+_[A-Za-z0-9]+$'
STAFF_POOL_VALUE=$(value_of COGNITO_STAFF_USER_POOL_ID)
STAFF_CLIENT_VALUE=$(value_of COGNITO_STAFF_CLIENT_ID)
if [ -z "${STAFF_POOL_VALUE}" ] && [ -z "${STAFF_CLIENT_VALUE}" ]; then
  if [ "${REQUIRE_STAFF_POOL}" -eq 1 ]; then
    MISSING+=("COGNITO_STAFF_USER_POOL_ID|staff pool id with MFA REQUIRED (ADR-025); see docs/ops/runbook-staff-pool.md")
    MISSING+=("COGNITO_STAFF_CLIENT_ID|the staff pool's app client id; see docs/ops/runbook-staff-pool.md")
  else
    WARNINGS+=("COGNITO_STAFF_USER_POOL_ID|not set: internal roles still sign in without MFA (ADR-025); required for security go-live")
    WARNINGS+=("COGNITO_STAFF_CLIENT_ID|not set: see docs/ops/runbook-staff-pool.md")
  fi
elif [ -z "${STAFF_POOL_VALUE}" ] || [ -z "${STAFF_CLIENT_VALUE}" ]; then
  [ -z "${STAFF_POOL_VALUE}" ] && MISSING+=("COGNITO_STAFF_USER_POOL_ID|must be set together with COGNITO_STAFF_CLIENT_ID")
  [ -z "${STAFF_CLIENT_VALUE}" ] && MISSING+=("COGNITO_STAFF_CLIENT_ID|must be set together with COGNITO_STAFF_USER_POOL_ID")
else
  if ! printf '%s' "${STAFF_POOL_VALUE}" | grep -Eq "${POOL_ID_PATTERN}"; then
    MISSING+=("COGNITO_STAFF_USER_POOL_ID|not a Cognito user pool id (region_suffix)")
  fi
  if [ "${STAFF_POOL_VALUE}" = "$(value_of COGNITO_USER_POOL_ID)" ]; then
    MISSING+=("COGNITO_STAFF_USER_POOL_ID|names the student pool; it must be the separate staff pool")
  fi
  if [ "${STAFF_CLIENT_VALUE}" = "$(value_of COGNITO_CLIENT_ID)" ]; then
    MISSING+=("COGNITO_STAFF_CLIENT_ID|equals COGNITO_CLIENT_ID; it must be the staff pool's own client")
  fi
fi

for entry in "${WARNINGS[@]+"${WARNINGS[@]}"}"; do
  printf 'warning: %-28s %s
' "${entry%%|*}" "${entry#*|}" >&2
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "app.env is not ready for production mode. Add or fix these lines in ${APP_ENV}:" >&2
  for entry in "${MISSING[@]}"; do
    printf '  %-28s %s\n' "${entry%%|*}" "${entry#*|}" >&2
  done
  exit 2
fi

echo "preflight: app.env satisfies production-mode startup requirements"
