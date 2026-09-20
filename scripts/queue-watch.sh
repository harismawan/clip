#!/usr/bin/env bash
#
# Live queue monitor for the pg-boss queue and the app's own job rows.
#
#   ./scripts/queue-watch.sh          # refreshing dashboard (2s)
#   ./scripts/queue-watch.sh 5        # refreshing dashboard (5s)
#   ./scripts/queue-watch.sh once     # single snapshot, pipeable
#
# The whole ops surface of this queue is four numbers -- depth, age, what is
# running, and what failed. Deploying a dashboard to read them would mean
# running a web service to query a table.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

CONTAINER="${PG_CONTAINER:-clip-postgres-1}"

# psql is not installed on this host, so go through the container by default.
if command -v psql >/dev/null 2>&1 && [ "${USE_LOCAL_PSQL:-0}" = "1" ]; then
  PSQL=(psql "${DATABASE_URL:?DATABASE_URL not set}")
else
  PSQL=(docker exec -i "$CONTAINER" psql -U "${POSTGRES_USER:-clip}" -d "${POSTGRES_DB:-clip}")
fi

read -r -d '' SQL <<'EOF' || true
\pset border 2
\pset null '-'

\echo '=== QUEUE DEPTH ==='
SELECT name AS queue,
       state,
       count(*) AS jobs,
       max(now() - created_on)::interval(0) AS oldest
FROM pgboss.job
GROUP BY name, state
ORDER BY name, state;

\echo ''
\echo '=== ACTIVE NOW ==='
SELECT name AS queue,
       (now() - started_on)::interval(0) AS running_for,
       data->>'jobId' AS app_job
FROM pgboss.job
WHERE state = 'active'
ORDER BY started_on;

\echo ''
\echo '=== RECENT QUEUE FAILURES (1h) ==='
SELECT name AS queue,
       completed_on::timestamp(0) AS failed_at,
       left(coalesce(output->>'message', output::text), 70) AS error
FROM pgboss.job
WHERE state = 'failed' AND completed_on > now() - interval '1 hour'
ORDER BY completed_on DESC
LIMIT 5;

\echo ''
\echo '=== APP JOBS ==='
SELECT j.status,
       count(*) AS n,
       max(j.progress) AS max_pct,
       max(now() - j.started_at)::interval(0) AS longest_running
FROM jobs j
GROUP BY j.status
ORDER BY j.status;

\echo ''
\echo '=== IN FLIGHT ==='
SELECT left(j.id::text, 8) AS job,
       j.status,
       j.progress || '%' AS pct,
       j.stage,
       left(v.title, 34) AS source,
       (now() - j.started_at)::interval(0) AS elapsed
FROM jobs j
JOIN videos v ON v.id = j.video_id
WHERE j.status NOT IN ('completed', 'failed', 'cancelled')
ORDER BY j.created_at DESC
LIMIT 10;

\echo ''
\echo '=== RECENT APP FAILURES (24h) ==='
SELECT left(j.id::text, 8) AS job,
       j.stage,
       left(coalesce(j.error, ''), 60) AS error,
       j.completed_at::timestamp(0) AS at
FROM jobs j
WHERE j.status = 'failed' AND j.completed_at > now() - interval '24 hours'
ORDER BY j.completed_at DESC
LIMIT 5;
EOF

snapshot() {
  # pgboss schema does not exist until the worker has started once.
  printf '%s' "$SQL" | "${PSQL[@]}" -X -q 2>&1 |
    sed 's/^ERROR:  relation "pgboss.job" does not exist.*/(queue not initialised yet -- start the worker)/'
}

case "${1:-}" in
  once) snapshot ;;
  *)
    interval="${1:-2}"
    export -f snapshot 2>/dev/null || true
    while true; do
      clear
      printf 'clip queue — %s (refresh %ss, Ctrl-C to stop)\n\n' "$(date '+%H:%M:%S')" "$interval"
      snapshot
      sleep "$interval"
    done
    ;;
esac
