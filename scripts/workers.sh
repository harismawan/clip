#!/usr/bin/env bash
#
# Who is working the queue, and the switch for the one on this box.
#
#   ./scripts/workers.sh                 # status: every connected worker, anywhere
#   ./scripts/workers.sh start           # start pm2's clip-worker (refuses if one is connected)
#   ./scripts/workers.sh stop            # stop it (refuses mid-job)
#   ./scripts/workers.sh restart
#   ./scripts/workers.sh logs [lines]
#
#   add --force to start/stop/restart to skip the refusal
#
# The count comes from Postgres, not pm2, because pm2 only knows about this
# box. A worker in a container, or on a laptop through an SSH tunnel, is
# invisible to it -- and one of those claiming production jobs while pm2 said
# `stopped` is how cancels got silently undone. Every worker connection names
# itself `clip-worker:<host>:<pid>` (see workerAppName in shared/queue.ts), so
# pg_stat_activity sees them all, from wherever they connect.
#
# A worker running code from before that naming shows up as UNIDENTIFIED: its
# connections are labelled `pgboss` and are caught polling for jobs, which the
# API never does.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

CONTAINER="${PG_CONTAINER:-clip-postgres-1}"
APP=clip-worker
PREFIX=clip-worker # WORKER_APP_PREFIX in shared/queue.ts

# psql is not installed on this host, so go through the container, as
# queue-watch.sh does.
if command -v psql >/dev/null 2>&1 && [ "${USE_LOCAL_PSQL:-0}" = "1" ]; then
  PSQL=(psql "${DATABASE_URL:?DATABASE_URL not set}")
else
  PSQL=(docker exec -i "$CONTAINER" psql -U "${POSTGRES_USER:-clip}" -d "${POSTGRES_DB:-clip}")
fi

q() { "${PSQL[@]}" -XAtq -c "$1"; }

bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' yel=$'\e[33m' grn=$'\e[32m' off=$'\e[0m'
[ -t 1 ] || bold='' dim='' red='' yel='' grn='' off=''
warn() { echo "${yel}! $*${off}"; }
bad() { echo "${red}✗ $*${off}"; }
good() { echo "${grn}✓ $*${off}"; }

# Named workers: one row per process, however many connections it holds.
named_workers() {
  q "SELECT substring(application_name from '^${PREFIX}:(.*):[0-9]+\$'),
            substring(application_name from ':([0-9]+)\$'),
            count(*),
            to_char(min(backend_start) AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD HH24:MI')
     FROM pg_stat_activity
     WHERE datname = current_database() AND application_name LIKE '${PREFIX}:%'
     GROUP BY application_name ORDER BY min(backend_start);"
}

# Connections polling pg-boss for work without a name: an older worker. The
# API's pg-boss only sends and deletes jobs, so it never runs this query.
unidentified_count() {
  q "SELECT count(*) FROM pg_stat_activity
     WHERE datname = current_database()
       AND application_name IN ('pgboss', '')
       AND query ILIKE '%WITH next as%';"
}

# SSH tunnels into the database port. Needs root to attribute sockets to sshd,
# so this is best-effort: without passwordless sudo it says nothing.
tunnels() {
  local port="${POSTGRES_PORT:-5445}" out
  out=$(sudo -n ss -tnp state established "( dport = :$port )" 2>/dev/null) || return 0
  grep -oE '"sshd",pid=[0-9]+' <<<"$out" | grep -oE '[0-9]+$' | sort | uniq -c | while read -r n pid; do
    from=$(sudo -n ss -tnp state established '( sport = :22 )' 2>/dev/null \
      | grep "pid=$pid," | awk '{print $4}' | head -1)
    echo "$n $pid ${from:-unknown}"
  done
}

local_status() {
  pm2 jlist 2>/dev/null | python3 -c '
import sys, json
for p in json.load(sys.stdin):
    if p["name"] == "'"$APP"'":
        e = p["pm2_env"]; print(e["status"], p.get("pid") or "-", e.get("restart_time", 0))
        break
else:
    print("absent - 0")' 2>/dev/null || echo "unknown - 0"
}

in_flight() {
  q "SELECT count(*) FROM jobs WHERE status NOT IN ('completed','failed','cancelled');"
}

# Total processes working the queue. Unidentified connections count as one
# worker: they cannot be told apart, and one is already one too many to ignore.
worker_total() {
  local named unid
  named=$(named_workers | grep -c . || true)
  unid=$(unidentified_count)
  echo $((named + (unid > 0 ? 1 : 0)))
}

status() {
  echo "${bold}=== WORKERS CONNECTED (from Postgres: every host, every route in) ===${off}"
  local rows unid total
  rows=$(named_workers)
  if [ -n "$rows" ]; then
    printf "  %-28s %-8s %-6s %s\n" HOST PID CONNS SINCE
    while IFS='|' read -r host pid conns since; do
      mark=''
      [ "$host" = "${WORKER_HOST_ID:-$(hostname)}" ] && mark=" ${dim}(this box)${off}"
      printf "  %-28s %-8s %-6s %s%s\n" "$host" "$pid" "$conns" "$since" "$mark"
    done <<<"$rows"
  fi
  unid=$(unidentified_count)
  if [ "$unid" -gt 0 ]; then
    printf "  %-28s %-8s %-6s %s\n" "${red}UNIDENTIFIED${off}" "?" "$unid" "polling for jobs now"
  fi
  [ -z "$rows" ] && [ "$unid" -eq 0 ] && echo "  none"

  local t
  # `|| true`: no tunnel is the normal case, and under pipefail the empty grep
  # inside would otherwise abort the whole script.
  t=$(tunnels || true)
  if [ -n "$t" ]; then
    echo
    echo "${bold}=== VIA SSH TUNNEL ===${off}"
    while read -r n pid from; do
      echo "  $n DB connection(s) through sshd pid $pid, from $from"
    done <<<"$t"
  fi

  echo
  echo "${bold}=== THIS BOX (pm2) ===${off}"
  read -r st pid restarts <<<"$(local_status)"
  echo "  $APP: $st (pid $pid, $restarts restarts)"

  echo
  echo "${bold}=== JOBS IN FLIGHT ===${off}"
  "${PSQL[@]}" -Xq -P border=1 -P footer=off -c "
    SELECT left(j.id::text, 8) AS job, left(v.title, 40) AS video, j.status, j.stage,
           j.progress || '%' AS pct, (now() - j.created_at)::interval(0) AS age,
           CASE WHEN j.deleted_at IS NOT NULL THEN 'deleted' ELSE '' END AS note
    FROM jobs j JOIN videos v ON v.id = j.video_id
    WHERE j.status NOT IN ('completed','failed','cancelled')
    ORDER BY j.created_at;" | sed 's/^/  /'

  echo
  total=$(worker_total)
  local queued
  queued=$(q "SELECT count(*) FROM pgboss.job WHERE state IN ('created','retry');")
  if [ "$total" -gt 1 ]; then
    bad "$total workers share one queue. They race for jobs, and a starting worker fails the others' in-flight jobs as orphans."
  elif [ "$total" -eq 1 ] && [ "$unid" -gt 0 ]; then
    warn "1 worker, running code too old to name itself. Find it before starting another."
  elif [ "$total" -eq 1 ]; then
    good "1 worker"
  elif [ "$queued" -gt 0 ] || [ "$(in_flight)" -gt 0 ]; then
    bad "No worker connected, and work is waiting: $queued queued, $(in_flight) in flight. Nothing will run."
  else
    echo "No worker connected. Nothing is waiting."
  fi
}

refuse_if_connected() {
  [ "$FORCE" = 1 ] && return 0
  local total
  total=$(worker_total)
  if [ "$total" -gt 0 ]; then
    bad "Refusing: $total worker(s) already connected (see below)."
    echo "  A worker starting up assumes it is alone: it fails every in-flight job as"
    echo "  orphaned, including the ones the other worker is still running."
    echo "  Stop the other one first, or pass --force if you know it is gone."
    echo
    status
    exit 1
  fi
}

refuse_if_busy() {
  [ "$FORCE" = 1 ] && return 0
  local n
  n=$(in_flight)
  if [ "$n" -gt 0 ]; then
    bad "Refusing: $n job(s) in flight."
    echo "  pm2 SIGKILLs the worker 10s after asking it to stop, so a running job is"
    echo "  abandoned and failed on the next start. Wait, cancel it, or pass --force."
    exit 1
  fi
}

start() {
  refuse_if_connected
  # delete-then-start from the ecosystem file, exactly as deploy.sh does: pm2
  # keeps the settings an app was created with, so a plain restart would ignore
  # changes to ecosystem.config.cjs.
  pm2 delete "$APP" >/dev/null 2>&1 || true
  pm2 start ecosystem.config.cjs --only "$APP" --update-env >/dev/null
  pm2 save >/dev/null 2>&1 || true

  # pm2 says `online` as soon as the process exists. Connected to the queue is
  # the thing that matters, so wait for its name to appear in Postgres -- by
  # PID, so a previous worker's lingering connections cannot pass for it.
  local pid
  pid=$(pm2 pid "$APP" 2>/dev/null | tail -1)
  for _ in $(seq 1 30); do
    if named_workers | grep -q "|$pid|"; then
      good "$APP started and connected"
      echo
      status
      return 0
    fi
    sleep 1
  done
  bad "$APP did not connect within 30s. Last log lines:"
  pm2 logs "$APP" --lines 20 --nostream 2>&1 | tail -20
  exit 1
}

stop() {
  refuse_if_busy
  pm2 stop "$APP" >/dev/null
  # Its connections close a moment after the process does. Wait for them, so a
  # restart does not find the worker it just stopped and refuse to start.
  local me="${WORKER_HOST_ID:-$(hostname)}"
  for _ in $(seq 1 15); do
    named_workers | grep -q "^$me|" || break
    sleep 1
  done
  good "$APP stopped"
}

cmd="${1:-status}"
FORCE=0
for a in "$@"; do [ "$a" = "--force" ] && FORCE=1; done

case "$cmd" in
  status) status ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  logs) pm2 logs "$APP" --lines "${2:-50}" --nostream ;;
  -h | --help | help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "unknown command: $cmd (try --help)" >&2; exit 2 ;;
esac
