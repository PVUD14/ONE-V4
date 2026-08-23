#!/usr/bin/env bash
# Daily database backup with a restore proof.
#
# A dump that has never been restored is not a backup; it is a file that might be a
# backup. Every run therefore restores what it just produced into a scratch database
# and compares it against the source before the dump is treated as good. A dump that
# fails to restore is deleted rather than kept, so a broken file can never sit in the
# directory looking like protection.
#
# Exits non-zero on any failure so the timer surfaces it instead of reporting success.
set -euo pipefail

ROOT=${PLANTHEPATH_ROOT:-/srv/planthepath-next}
BACKUP_DIR=${BACKUP_DIR:-${ROOT}/shared/backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
TS=$(date -u +%Y%m%dT%H%M%SZ)

fail_ping() {
  [ -n "${BACKUP_PING_URL:-}" ] && curl -fsS -m 10 "${BACKUP_PING_URL}/fail" >/dev/null 2>&1 || true
}

install -d -m 700 "${BACKUP_DIR}"

DATABASE_URL=${DATABASE_URL:-}
if [ -z "${DATABASE_URL}" ] && [ -f "${ROOT}/shared/app.env" ]; then
  DATABASE_URL=$(grep -s '^DATABASE_URL=' "${ROOT}/shared/app.env" | sed 's/^DATABASE_URL=//' | tail -n 1 || true)
fi
if [ -z "${DATABASE_URL}" ]; then
  echo '{"event":"backup.failed","reason":"DATABASE_URL not found"}' >&2
  fail_ping
  exit 20
fi

# Parsed in shell rather than with node: a backup must still run when the application
# runtime is broken, which is exactly when it is most needed.
urldecode() { printf '%b' "${1//%/\\x}"; }

REST=${DATABASE_URL#*://}
CREDS=${REST%%@*}
HOSTPART=${REST#*@}
USER=$(urldecode "${CREDS%%:*}")
PASS=$(urldecode "${CREDS#*:}")
HOSTPORT=${HOSTPART%%/*}
DB=${HOSTPART#*/}
DB=${DB%%\?*}
HOST=${HOSTPORT%%:*}
PORT=${HOSTPORT#*:}
[ "${PORT}" = "${HOST}" ] && PORT=5432

if [ -z "${HOST}" ] || [ -z "${USER}" ] || [ -z "${DB}" ]; then
  echo '{"event":"backup.failed","reason":"DATABASE_URL could not be parsed"}' >&2
  exit 20
fi
export PGPASSWORD="${PASS}"

BACKUP="${BACKUP_DIR}/${DB}_${TS}.dump"
VERIFY_DB="${DB}_verify_${TS}"

cleanup() {
  # The scratch database must never outlive the check, even on failure.
  psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d postgres -q \
    -c "DROP DATABASE IF EXISTS \"${VERIFY_DB}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- Take the dump ----------------------------------------------------------

pg_dump -Fc --no-owner --no-acl -h "${HOST}" -p "${PORT}" -U "${USER}" -d "${DB}" -f "${BACKUP}"
chmod 600 "${BACKUP}"
test -s "${BACKUP}"
SIZE=$(stat -c %s "${BACKUP}")
CHECKSUM=$(sha256sum "${BACKUP}" | awk '{print $1}')

# --- Prove it restores ------------------------------------------------------

# A restore needs room for a second copy. Refuse rather than fill the disk.
AVAILABLE=$(df -P "${BACKUP_DIR}" | awk 'NR==2 {print $4 * 1024}')
if [ "${AVAILABLE}" -lt "$((SIZE * 5))" ]; then
  rm -f "${BACKUP}"
  echo "{\"event\":\"backup.failed\",\"reason\":\"insufficient disk to verify restore\",\"availableBytes\":${AVAILABLE}}" >&2
  fail_ping
  exit 21
fi

psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d postgres -q -c "CREATE DATABASE \"${VERIFY_DB}\";"

# pg_restore reports non-fatal notices as errors on some objects; failure is judged
# by whether the data actually arrived, not by its exit code alone.
RESTORE_STATUS=0
pg_restore --no-owner --no-acl -h "${HOST}" -p "${PORT}" -U "${USER}" -d "${VERIFY_DB}" "${BACKUP}" >/dev/null 2>&1 || RESTORE_STATUS=$?

# Must not abort the run when it fails. A query that errors against the restored
# database is the very signal this script exists to catch: under `set -e` an
# unguarded failure here would kill the script before it could delete the bad dump.
count_query() {
  local output
  output=$(psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d "$1" -tAc "$2" 2>/dev/null || true)
  printf '%s' "${output}" | tr -d '[:space:]'
}

TABLE_SQL="SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
SOURCE_TABLES=$(count_query "${DB}" "${TABLE_SQL}")
VERIFY_TABLES=$(count_query "${VERIFY_DB}" "${TABLE_SQL}")

# Row counts on the tables whose loss would actually matter.
ROW_SQL="SELECT coalesce((SELECT count(*) FROM users),0) || ':' || coalesce((SELECT count(*) FROM organizations),0) || ':' || coalesce((SELECT count(*) FROM applications),0) || ':' || coalesce((SELECT count(*) FROM audit_events),0)"
SOURCE_ROWS=$(count_query "${DB}" "${ROW_SQL}")
VERIFY_ROWS=$(count_query "${VERIFY_DB}" "${ROW_SQL}")

VERIFIED=true
REASON=""
if [ "${SOURCE_TABLES}" != "${VERIFY_TABLES}" ] || [ -z "${VERIFY_TABLES}" ]; then
  VERIFIED=false; REASON="table count ${SOURCE_TABLES} vs ${VERIFY_TABLES}"
elif [ "${SOURCE_ROWS}" != "${VERIFY_ROWS}" ]; then
  # A mismatch here can be legitimate if the source changed mid-dump, but it is not
  # something to wave through unseen.
  VERIFIED=false; REASON="row counts ${SOURCE_ROWS} vs ${VERIFY_ROWS}"
fi

if [ "${VERIFIED}" != true ]; then
  # A dump that cannot be restored is worse than no dump, because it looks like one.
  rm -f "${BACKUP}"
  echo "{\"event\":\"backup.verify.failed\",\"reason\":\"${REASON}\",\"restoreExit\":${RESTORE_STATUS},\"deletedUnverifiedDump\":true}" >&2
  fail_ping
  exit 22
fi

# --- Copy off the host ------------------------------------------------------

# Backups on the database host protect against corruption and mistakes, not against
# losing the machine. Only after this step does the dump protect against that too.
OFFSITE="unconfigured"
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  if rclone copyto "${BACKUP}" "${BACKUP_RCLONE_REMOTE}/$(basename "${BACKUP}")" 2>/dev/null; then
    OFFSITE="rclone:ok"
  else
    OFFSITE="rclone:FAILED"
  fi
elif [ -n "${BACKUP_SCP_TARGET:-}" ]; then
  if scp -q -o BatchMode=yes -o ConnectTimeout=15 "${BACKUP}" "${BACKUP_SCP_TARGET}" 2>/dev/null; then
    OFFSITE="scp:ok"
  else
    OFFSITE="scp:FAILED"
  fi
fi
if [ "${OFFSITE}" = "unconfigured" ]; then
  echo '{"event":"backup.offsite.unconfigured","warning":"backups exist only on this host; a lost machine is still total loss"}' >&2
fi

# --- Retention --------------------------------------------------------------

PRUNED=$(find "${BACKUP_DIR}" -maxdepth 1 -name "${DB}_*.dump" -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
REMAINING=$(find "${BACKUP_DIR}" -maxdepth 1 -name "${DB}_*.dump" -type f | wc -l)

printf '{"event":"backup.verified","file":"%s","bytes":%s,"sha256":"%s","tables":%s,"rows":"%s","offsite":"%s","prunedOlderThanDays":%s,"pruned":%s,"retained":%s}\n' \
  "${BACKUP}" "${SIZE}" "${CHECKSUM}" "${SOURCE_TABLES}" "${SOURCE_ROWS}" "${OFFSITE}" "${RETENTION_DAYS}" "${PRUNED}" "${REMAINING}"

# Dead-man's switch: an external service that expects this ping daily will alert when
# it stops arriving, which is how a silently broken backup job becomes somebody's
# problem instead of nobody's. Ping failures never fail a good backup.
if [ -n "${BACKUP_PING_URL:-}" ]; then
  if [ "${OFFSITE}" = "rclone:FAILED" ] || [ "${OFFSITE}" = "scp:FAILED" ]; then
    curl -fsS -m 10 "${BACKUP_PING_URL}/fail" >/dev/null 2>&1 || true
  else
    curl -fsS -m 10 "${BACKUP_PING_URL}" >/dev/null 2>&1 || true
  fi
fi

# An off-host copy that failed is a degraded backup even though the local dump is
# good; surface it as a failure so the timer shows red rather than green.
if [ "${OFFSITE}" = "rclone:FAILED" ] || [ "${OFFSITE}" = "scp:FAILED" ]; then
  exit 23
fi
