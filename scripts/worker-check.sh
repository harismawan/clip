#!/usr/bin/env bash
#
# Is the worker healthy right now? One answer, one exit code.
#
#   ./scripts/worker-check.sh          # report, exit 0 if healthy
#   ./scripts/worker-check.sh --quiet  # exit code only, for cron
#
# queue-watch.sh shows what the QUEUE is doing, refreshing, for a human
# watching a job go through. This answers a different question -- "is the thing
# that drains that queue alive and able to work" -- and answers it once, with an
# exit code, so cron or a monitor can ask it too.
#
# It exists because a stopped worker is invisible: the site stays up, the API
# keeps accepting jobs, and they queue forever with no error anywhere. The only
# symptom is that nothing finishes.
#
# NOTE: pm2 lives in ~/.bun/bin, which cron does NOT have on PATH. From crontab:
#   PATH=/home/wildandev/.bun/bin:/usr/local/bin:/usr/bin:/bin
set -Eeuo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
[ -f .env ] && set -a && . ./.env && set +a

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

CONTAINER="${PG_CONTAINER:-clip-postgres-1}"
APP="clip-worker"
LOG="$HOME/.pm2/logs/clip-worker-out.log"
ERR="$HOME/.pm2/logs/clip-worker-error.log"

PROBLEMS=0
say()  { [ "$QUIET" = 1 ] || printf "%s\n" "$*"; }
ok()   { [ "$QUIET" = 1 ] || printf "  \033[32mok\033[0m   %s\n" "$*"; }
bad()  { PROBLEMS=$((PROBLEMS + 1)); [ "$QUIET" = 1 ] || printf "  \033[31mFAIL\033[0m %s\n" "$*"; }
warn() { [ "$QUIET" = 1 ] || printf "  \033[33mwarn\033[0m %s\n" "$*"; }

psql_q() { # one scalar, or empty if the database is unreachable
  docker exec -i "$CONTAINER" psql -U "${POSTGRES_USER:-clip}" -d "${POSTGRES_DB:-clip}" \
    -Xqtc "$1" 2>/dev/null | tr -d '[:space:]'
}

say ""
say "worker check — $(date '+%Y-%m-%d %H:%M:%S')"
say ""

# --- 1. the process ---------------------------------------------------------
# Checked first because everything below is meaningless if nothing is running,
# and because this is the failure that hides: pm2 says "stopped" while the
# website carries on looking perfectly fine.
if ! command -v pm2 >/dev/null; then
  bad "pm2 not on PATH (cron? see the note at the top of this script)"
else
  STATUS="$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    apps = json.load(sys.stdin)
except Exception:
    print('unreadable'); raise SystemExit
print(next((a['pm2_env']['status'] for a in apps if a['name'] == '$APP'), 'missing'))
" 2>/dev/null || echo unreadable)"

  case "$STATUS" in
    online) ok "process online" ;;
    missing) bad "no pm2 app named $APP — it was deleted, not stopped (pm2 start ecosystem.config.cjs)" ;;
    stopped) bad "process STOPPED — no job will ever be picked up (pm2 start $APP)" ;;
    errored) bad "process ERRORED — it is crashing on startup (pm2 logs $APP --err)" ;;
    *) bad "process status: $STATUS" ;;
  esac

  # A worker that restarts repeatedly is worse than one that is down: each
  # restart abandons whatever job it was holding.
  RESTARTS="$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
apps = json.load(sys.stdin)
print(next((a['pm2_env'].get('unstable_restarts', 0) for a in apps if a['name'] == '$APP'), 0))
" 2>/dev/null || echo 0)"
  [ "${RESTARTS:-0}" -gt 0 ] && warn "$RESTARTS unstable restart(s) — it is crashlooping"
fi

# --- 2. what it said when it last started -----------------------------------
# The startup line names the storage backend it resolved, which is the one
# piece of config that can make every render fail after the work is done.
if [ -f "$LOG" ]; then
  READY="$(grep -a 'worker ready' "$LOG" | tail -1 || true)"
  if [ -n "$READY" ]; then
    ok "last start: ${READY#*: }"
  else
    warn "no 'worker ready' line in the log yet"
  fi

  LAST_SIGNAL="$(grep -a 'finishing current work' "$LOG" | tail -1 || true)"
  # The whole ISO timestamp, not everything up to the first colon -- that cuts
  # "19:20:46" down to "19", which prints wrong AND compares equal for two
  # events in the same hour, hiding exactly the case this is looking for.
  iso() { printf '%s' "$1" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' || true; }
  READY_TS="$(iso "$READY")"; SIG_TS="$(iso "$LAST_SIGNAL")"
  # A shutdown newer than the last successful start means it went down and
  # never came back -- which is exactly how this goes unnoticed. Lexical
  # comparison is safe here: ISO-8601 sorts chronologically as text.
  if [ -n "$SIG_TS" ] && [[ "$SIG_TS" > "$READY_TS" ]]; then
    bad "shut down at $SIG_TS and never started again"
  fi
else
  warn "no pm2 log at $LOG"
fi

if [ -s "$ERR" ]; then
  warn "error log is not empty — last line:"
  [ "$QUIET" = 1 ] || tail -1 "$ERR" | cut -c1-120 | sed 's/^/       /'
else
  ok "error log clean"
fi

# --- 3. is work piling up? --------------------------------------------------
WAITING="$(psql_q "select count(*) from pgboss.job where name='process-video' and state='created';")"
ACTIVE="$(psql_q "select count(*) from pgboss.job where state='active';")"

if [ -z "$WAITING" ]; then
  bad "cannot reach Postgres (container '$CONTAINER' down?)"
else
  if [ "$WAITING" -gt 0 ] && [ "$ACTIVE" = 0 ]; then
    # Queued work with nothing running is the signature of a dead worker.
    bad "$WAITING job(s) queued and nothing running — the queue is not being drained"
  else
    ok "queue: $WAITING waiting, $ACTIVE active"
  fi
fi

# --- 4. jobs the worker abandoned -------------------------------------------
# A job whose row still says 'rendering' but has no queue entry was dropped
# when the worker died. Nothing retries it (retryLimit is 0) and it keeps
# consuming that user's daily quota slot until somebody releases it.
STUCK="$(psql_q "
  select count(*) from jobs j
  where j.status not in ('completed','failed','cancelled')
    and j.started_at < now() - interval '2 hours'
    and not exists (
      select 1 from pgboss.job q
      where q.state = 'active' and q.data->>'jobId' = j.id::text
    );")"

if [ -n "$STUCK" ] && [ "$STUCK" -gt 0 ]; then
  bad "$STUCK job(s) stranded mid-flight (bun run quota <email> --release)"
  [ "$QUIET" = 1 ] || docker exec -i "$CONTAINER" psql -U "${POSTGRES_USER:-clip}" \
    -d "${POSTGRES_DB:-clip}" -Xqc "
    select left(j.id::text,8) as job, u.email, j.status, j.progress||'%' as pct,
           (now()-j.started_at)::interval(0) as stuck_for
    from jobs j join users u on u.id = j.user_id
    where j.status not in ('completed','failed','cancelled')
      and j.started_at < now() - interval '2 hours'
    order by j.started_at;" 2>/dev/null | sed 's/^/       /'
elif [ -n "$STUCK" ]; then
  ok "no stranded jobs"
fi

say ""
if [ "$PROBLEMS" -eq 0 ]; then
  say "worker is healthy"
  exit 0
fi
say "worker is NOT healthy ($PROBLEMS problem(s) above)"
exit 1
