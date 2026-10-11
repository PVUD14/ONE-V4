#!/usr/bin/env bash
# Exercises preflight-production.sh against synthetic app.env files (OPS-07).
#
# The preflight guards a hand-run release, so a regression in it is found at the worst
# moment. This runs every staff-pool case with made-up, obviously fake values and checks
# the exit code and that no value is ever echoed. It touches nothing outside a temp dir.
#   bash deploy/scripts/test-preflight-production.sh
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFLIGHT="${HERE}/preflight-production.sh"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
FAILURES=0

base() {
  cat <<'ENV'
NODE_ENV=production
COGNITO_USER_POOL_ID=ap-south-1_studentsFAKE
COGNITO_CLIENT_ID=fake-student-client
AUTOMATION_SIGNING_SECRET=fake-secret-fake-secret-fake-secret-fake-secret
ENV
}

# name, expected exit, expected text in output ('' for none), extra env lines, args...
check() {
  local name=$1 expected=$2 expect_text=$3 extra=$4
  shift 4
  local file="${WORK}/${name}.env" output status
  { base; printf '%b' "${extra}"; } > "${file}"
  set +e
  output=$(bash "${PREFLIGHT}" "${file}" "$@" 2>&1)
  status=$?
  set -e
  local ok=1
  [ "${status}" -eq "${expected}" ] || ok=0
  if [ -n "${expect_text}" ] && ! printf '%s' "${output}" | grep -q -- "${expect_text}"; then ok=0; fi
  # Values must never be printed: none of the fake values may appear in the output.
  if printf '%s' "${output}" | grep -Eq 'FAKE|fake-'; then ok=0; fi
  if [ "${ok}" -eq 1 ]; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: exit ${status}, expected ${expected}; output:" >&2
    printf '%s\n' "${output}" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

check no-staff-pool-default 0 'warning: COGNITO_STAFF_USER_POOL_ID' ''
check no-staff-pool-required 2 'COGNITO_STAFF_USER_POOL_ID' '' --require-staff-pool
check staff-pool-complete 0 'satisfies' 'COGNITO_STAFF_USER_POOL_ID=ap-south-1_staffFAKE\nCOGNITO_STAFF_CLIENT_ID=fake-staff-client\n' --require-staff-pool
check staff-pool-half-pool 2 'COGNITO_STAFF_CLIENT_ID' 'COGNITO_STAFF_USER_POOL_ID=ap-south-1_staffFAKE\n'
check staff-pool-half-client 2 'COGNITO_STAFF_USER_POOL_ID' 'COGNITO_STAFF_CLIENT_ID=fake-staff-client\n'
check staff-pool-is-student-pool 2 'names the student pool' 'COGNITO_STAFF_USER_POOL_ID=ap-south-1_studentsFAKE\nCOGNITO_STAFF_CLIENT_ID=fake-staff-client\n'
check staff-client-is-student-client 2 'equals COGNITO_CLIENT_ID' 'COGNITO_STAFF_USER_POOL_ID=ap-south-1_staffFAKE\nCOGNITO_STAFF_CLIENT_ID=fake-student-client\n'
check staff-pool-malformed 2 'not a Cognito user pool id' 'COGNITO_STAFF_USER_POOL_ID=staffFAKE\nCOGNITO_STAFF_CLIENT_ID=fake-staff-client\n'
check unknown-option 64 'unknown option' '' --bogus

if [ "${FAILURES}" -gt 0 ]; then
  echo "${FAILURES} preflight case(s) failed" >&2
  exit 1
fi
echo "preflight: all staff-pool cases pass"
