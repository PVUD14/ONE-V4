#!/usr/bin/env bash
# Five-minute health monitor.
#
# Checks the things whose failure a person must hear about: the public site, the API
# behind it, the services, the disk, the certificate, the backup chain and the
# scheduled jobs. Collects every failure rather than stopping at the first, because
# an operator woken at night needs the whole picture, not the first symptom.
#
# Pair with a dead-man's switch (MONITOR_PING_URL): the external service alerts when
# the ping stops arriving OR when the fail endpoint is hit, so both "host is down"
# and "host is up but broken" reach a human.
set -uo pipefail

ROOT=${PLANTHEPATH_ROOT:-/srv/planthepath-next}
PUBLIC_URL=${MONITOR_PUBLIC_URL:-https://oneby8.com}
LOCAL_API=${MONITOR_LOCAL_API:-http://127.0.0.1:7310}
BACKUP_DIR=${BACKUP_DIR:-${ROOT}/shared/backups}
BACKUP_MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-26}
CERT_MIN_DAYS=${CERT_MIN_DAYS:-14}
DISK_MAX_PERCENT=${DISK_MAX_PERCENT:-90}

FAILURES=()

check() { # name, condition-command...
  local name=$1; shift
  if ! "$@" >/dev/null 2>&1; then FAILURES+=("${name}"); fi
}

# 1. The public site answers, and answers healthily.
PUBLIC_BODY=$(curl -fsS -m 15 "${PUBLIC_URL}/health" 2>/dev/null || true)
[ "${PUBLIC_BODY}" = '{"status":"ok"}' ] || FAILURES+=("public-health")

# 2. The API itself, bypassing the proxy, so a proxy fault and an API fault read
#    differently in the failure list.
LOCAL_BODY=$(curl -fsS -m 10 "${LOCAL_API}/health" 2>/dev/null || true)
[ "${LOCAL_BODY}" = '{"status":"ok"}' ] || FAILURES+=("local-api-health")

# 3. Services.
check "api-service" systemctl is-active --quiet planthepath-api.service

# 4. Any failed scheduled job: this is how a broken deletion sweep or backup retry
#    exhaustion becomes visible without its own alert channel.
FAILED_UNITS=$(systemctl list-units --state=failed --plain --no-legend 'planthepath-*' 2>/dev/null | awk '{print $1}' | paste -sd, - || true)
[ -z "${FAILED_UNITS}" ] || FAILURES+=("failed-units:${FAILED_UNITS}")

# 5. Disk.
DISK_USED=$(df -P "${ROOT}" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [ -n "${DISK_USED:-}" ] && [ "${DISK_USED}" -ge "${DISK_MAX_PERCENT}" ]; then
  FAILURES+=("disk-${DISK_USED}pct")
fi

# 6. Backup freshness: a timer that quietly stopped firing looks identical to a
#    healthy one until the day the dump is needed.
if [ -d "${BACKUP_DIR}" ]; then
  NEWEST=$(find "${BACKUP_DIR}" -maxdepth 1 -name '*.dump' -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
  if [ -z "${NEWEST}" ]; then
    FAILURES+=("no-backups")
  else
    AGE_HOURS=$(( ( $(date +%s) - ${NEWEST%.*} ) / 3600 ))
    [ "${AGE_HOURS}" -le "${BACKUP_MAX_AGE_HOURS}" ] || FAILURES+=("backup-stale-${AGE_HOURS}h")
  fi
else
  FAILURES+=("no-backup-dir")
fi

# 7. Certificate expiry, checked from the outside like a browser would.
CERT_END=$(echo | openssl s_client -servername "${PUBLIC_URL#https://}" -connect "${PUBLIC_URL#https://}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)
if [ -n "${CERT_END}" ]; then
  CERT_DAYS=$(( ( $(date -d "${CERT_END}" +%s) - $(date +%s) ) / 86400 ))
  [ "${CERT_DAYS}" -ge "${CERT_MIN_DAYS}" ] || FAILURES+=("cert-expires-${CERT_DAYS}d")
else
  FAILURES+=("cert-unreadable")
fi

# 8. The malware scanner, if uploads are switched on.
if grep -qs '^FILE_STORAGE_ROOT=' "${ROOT}/shared/app.env"; then
  SOCKET=$(grep -s '^CLAMAV_SOCKET_PATH=' "${ROOT}/shared/app.env" | cut -d= -f2 || true)
  if [ -n "${SOCKET}" ] && [ ! -S "${SOCKET}" ]; then FAILURES+=("clamd-socket-missing"); fi
fi

if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "{\"event\":\"monitor.ok\",\"disk\":\"${DISK_USED:-?}%\",\"certDays\":${CERT_DAYS:-null}}"
  [ -n "${MONITOR_PING_URL:-}" ] && curl -fsS -m 10 "${MONITOR_PING_URL}" >/dev/null 2>&1 || true
  exit 0
fi

REASONS=$(printf '%s,' "${FAILURES[@]}")
echo "{\"event\":\"monitor.failed\",\"failures\":\"${REASONS%,}\"}" >&2
[ -n "${MONITOR_PING_URL:-}" ] && curl -fsS -m 10 --data-raw "${REASONS%,}" "${MONITOR_PING_URL}/fail" >/dev/null 2>&1 || true
exit 1
