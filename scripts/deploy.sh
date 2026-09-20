#!/usr/bin/env bash
#
# Full-stack deploy for clip: infra (Postgres + MinIO), API, worker, frontend
# bundle and the nginx site — in one command.
#
# The three independent stages run in PARALLEL; everything after them is
# ordered by real dependencies:
#
#     infra up ──┐                 frontend build ──┐      bun install ──┐
#                └─> wait for pg ──> db:migrate ──> pm2 restart api+worker
#                                                        │
#                    nginx sync+reload ──> publish web dist ──> health checks
#
# Deliberately NOT done here:
#   * touching .env — real secrets, placed once by hand
#   * `git pull` — you deploy the tree you are looking at, not a moving target
#
# Usage: scripts/deploy.sh [options]   (run from anywhere)
#   --skip-infra     don't touch docker compose
#   --skip-web       don't build/publish the frontend
#   --skip-api       don't install/migrate/restart the API and worker
#   --skip-nginx     don't sync the nginx site config
#   --serial         run stages one at a time (easier to read when debugging)
#   -h, --help       show this
#
# Auth is Google sign-in with a session cookie; nginx carries no gate of its own.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SITE="clip2.mhamzah.id"
WEB_DIST_TARGET="/var/www/html/clip2/dist"
NGINX_AVAILABLE="/etc/nginx/sites-available/$SITE"
NGINX_REPO_CONF="$REPO_ROOT/deploy/nginx/$SITE"
PM2_APPS=( "clip-api" "clip-worker" )
ECOSYSTEM="$REPO_ROOT/ecosystem.config.cjs"

DO_INFRA=1 DO_WEB=1 DO_API=1 DO_NGINX=1 PARALLEL=1
for arg in "$@"; do
  case "$arg" in
    --skip-infra) DO_INFRA=0 ;;
    --skip-web)   DO_WEB=0 ;;
    --skip-api)   DO_API=0 ;;
    --skip-nginx) DO_NGINX=0 ;;
    --serial)     PARALLEL=0 ;;
    -h|--help)    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

LOG_DIR="$(mktemp -d /tmp/clip-deploy.XXXXXX)"
START_TS=$SECONDS
trap 'rc=$?; [ $rc -ne 0 ] && echo "" && echo "DEPLOY FAILED (exit $rc). Logs kept in $LOG_DIR" >&2; exit $rc' EXIT

say()  { printf "\n\033[1m==> %s\033[0m\n" "$*"; }
info() { printf "    %s\n" "$*"; }
ok()   { printf "    \033[32mok\033[0m %s\n" "$*"; }
warn() { printf "    \033[33mwarn\033[0m %s\n" "$*"; }
die()  { printf "\033[31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

# Read one key from the root .env without sourcing it -- sourcing would execute
# whatever is in there and leak every secret into this shell's environment.
envval() { grep -E "^$1=" "$REPO_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'[:space:]'; }

# ---------------------------------------------------------------- preflight
# Fail before mutating anything, rather than half-deploying and stopping.
say "preflight"
need() { command -v "$1" >/dev/null || die "missing required command: $1"; }
need bun; need docker; need curl
[ "$DO_API"   = 1 ] && need pm2
[ "$DO_WEB"   = 1 ] && need rsync
[ "$DO_NGINX" = 1 ] && need nginx

[ -f "$REPO_ROOT/.env" ] || die ".env missing (copy .env.example and fill it in)"

API_PORT="$(envval PORT)"; API_PORT="${API_PORT:-3004}"
PUBLIC_API_URL="$(envval PUBLIC_API_URL)"
API_TOKEN="$(envval API_TOKEN)"
OPENROUTER_API_KEY="$(envval OPENROUTER_API_KEY)"
GOOGLE_CLIENT_ID="$(envval GOOGLE_CLIENT_ID)"
GOOGLE_CLIENT_SECRET="$(envval GOOGLE_CLIENT_SECRET)"

[ -n "$API_TOKEN" ] || die "API_TOKEN is empty in .env (signs media URLs)"
[ -n "$OPENROUTER_API_KEY" ] || die "OPENROUTER_API_KEY is empty in .env (range selection will fail after transcription)"

# Without these the API refuses to boot, so catch it here rather than watching
# pm2 crashloop. The redirect URI is derived from PUBLIC_API_URL and must match
# the Google client exactly.
if [ -z "$GOOGLE_CLIENT_ID" ] || [ -z "$GOOGLE_CLIENT_SECRET" ]; then
  die "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are empty in .env.
       Create an OAuth 2.0 Web application client at
         https://console.cloud.google.com/apis/credentials
       with this authorized redirect URI:
         https://$SITE/api/auth/google/callback"
fi

# The worker is the half that does the work, and every one of these fails only
# AFTER a multi-GB download if it is missing. Check them while it is free.
if [ "$DO_API" = 1 ]; then
  need ffmpeg; need ffprobe; need yt-dlp
  [ -x "$REPO_ROOT/worker/.venv/bin/whisper-ctranslate2" ] \
    || die "worker/.venv/bin/whisper-ctranslate2 missing — run scripts/setup-python.sh"
  [ -f "$REPO_ROOT/worker/python/face_landmarker.task" ] \
    || warn "face_landmarker.task missing — reframe will fall back to a static centre crop"
  [ -f "$ECOSYSTEM" ] || die "missing $ECOSYSTEM"
fi

# The port the vhost proxies to and the port the API binds must agree. Getting
# this wrong is not a 502 -- 3004 on this box belongs to another application, so
# the site would quietly serve someone else's API.
if [ "$DO_NGINX" = 1 ] || [ "$DO_API" = 1 ]; then
  CONF_PORT="$(grep -oE 'proxy_pass http://127\.0\.0\.1:[0-9]+' "$NGINX_REPO_CONF" | grep -oE '[0-9]+$' | sort -u)"
  [ "$(echo "$CONF_PORT" | wc -l)" = 1 ] || die "$NGINX_REPO_CONF proxies to more than one port: $(echo "$CONF_PORT" | tr '\n' ' ')"
  [ "$CONF_PORT" = "$API_PORT" ] || die "port mismatch: .env PORT=$API_PORT but $SITE proxies to $CONF_PORT"
fi

# Signed media URLs are built against PUBLIC_API_URL. Left at localhost, every
# thumbnail and download link points at a host the visitor's browser cannot
# reach -- and the signature is bound to it, so it cannot be rewritten later.
if [ "$DO_API" = 1 ] && [ "$PUBLIC_API_URL" != "https://$SITE" ]; then
  die "PUBLIC_API_URL is '$PUBLIC_API_URL'; for this deploy it must be https://$SITE"
fi

# DEV AND PROD SHARE THIS BOX, THIS PORT AND THIS .env.
#
# `bun run dev:api` binds the same PORT, so pm2 would crashloop on EADDRINUSE
# and report "errored" a second after saying "online". Worse, a `bun run
# dev:worker` left running would sit on the same pg-boss queue as the pm2
# worker: whichever claims a job first wins, so half the jobs would run under
# whatever code and environment that stale terminal happens to hold.
if [ "$DO_API" = 1 ]; then
  if ss -ltn 2>/dev/null | grep -qE "[:.]$API_PORT\b" && ! pm2 describe clip-api >/dev/null 2>&1; then
    die "something already listens on :$API_PORT and it is not pm2's clip-api.
       That is almost certainly 'bun run dev:api'. Stop the dev servers first."
  fi
  if pgrep -f 'cwd=worker|worker/src/index.ts' >/dev/null 2>&1 && ! pm2 describe clip-worker >/dev/null 2>&1; then
    die "a worker is running outside pm2 (likely 'bun run dev:worker').
       Two workers share one queue and race for jobs. Stop it first."
  fi
fi

ok "tooling, env and ports consistent (API :$API_PORT)"

# ------------------------------------------------------------ stage runners
declare -A JOB_PID
start_stage() { # name, function
  local name=$1 fn=$2
  if [ "$PARALLEL" = 1 ]; then
    ( "$fn" ) >"$LOG_DIR/$name.log" 2>&1 &
    JOB_PID[$name]=$!
    info "started: $name"
  else
    say "$name"
    "$fn" 2>&1 | sed 's/^/    /'
  fi
}
await_stage() { # name
  local name=$1
  [ "$PARALLEL" = 1 ] || return 0
  [ -n "${JOB_PID[$name]:-}" ] || return 0
  if wait "${JOB_PID[$name]}"; then
    ok "$name"
  else
    echo ""; echo "--- $name failed; last 40 lines ---" >&2
    tail -40 "$LOG_DIR/$name.log" >&2
    die "stage '$name' failed"
  fi
}

# ------------------------------------------------------------------- stages
# Every `cd` is wrapped in a subshell: in --serial mode these run in THIS shell,
# so a bare `cd` would leak and make later relative paths resolve elsewhere.
stage_infra() {
  # --env-file is not optional: infra/docker-compose.yml reads ports and
  # credentials from the root .env, and without it the containers come up with
  # defaults that do not match what the API and worker connect to.
  ( cd "$REPO_ROOT" && docker compose -f infra/docker-compose.yml --env-file .env up -d )
}

stage_web_build() {
  (
    cd "$REPO_ROOT/frontend"
    bun install --frozen-lockfile 2>/dev/null || bun install
    # VITE_API_URL stays unset on purpose: in production the SPA and API share
    # an origin, and the client's default of a bare "/api" is what we want.
    # Nothing secret is passed in: the bundle holds no credential at all since
    # sign-in moved to a session cookie. VITE_API_TOKEN used to be inlined here,
    # which is exactly why it could never be the gate.
    bun run build
    [ -f dist/index.html ] || { echo "build produced no dist/index.html"; exit 1; }

    # A bundle that names localhost is a bundle built with a dev .env.
    #
    # frontend/.env.local once set VITE_API_URL=http://localhost:3014, and Vite
    # loads .env.local in EVERY mode -- so the production build pointed every API
    # call, and the sign-in redirect, at the visitor's own machine. The client has
    # no configurable base URL any more, and this makes the mistake impossible to
    # ship rather than merely unlikely.
    if grep -rqE 'https?://(localhost|127\.0\.0\.1)' dist/assets/*.js; then
      echo "build references localhost -- a dev .env leaked into it:"
      grep -rhoE 'https?://(localhost|127\.0\.0\.1)[:0-9]*' dist/assets/*.js | sort -u
      echo "remove frontend/.env.local (and any VITE_API_URL) and rebuild"
      exit 1
    fi
  )
}

stage_deps() {
  # One install at the root covers every workspace (shared, backend, worker).
  ( cd "$REPO_ROOT" && { bun install --frozen-lockfile 2>/dev/null || bun install; } )
}

wait_for_postgres() {
  local tries=60
  # `docker compose up -d` returns as soon as the container starts, which is
  # well before Postgres accepts connections. Migrating into that gap fails.
  until docker compose -f "$REPO_ROOT/infra/docker-compose.yml" --env-file "$REPO_ROOT/.env" \
        exec -T postgres pg_isready -q 2>/dev/null; do
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || die "postgres did not become ready in 60s"
    sleep 1
  done
}

publish_web() {
  sudo mkdir -p "$WEB_DIST_TARGET"
  # rsync --delete rather than rm -rf + cp: files are replaced in place, so
  # there is no window where the document root is empty and the site 404s.
  sudo rsync -a --delete "$REPO_ROOT/frontend/dist/" "$WEB_DIST_TARGET/"
  sudo chown -R "$(id -un):www-data" "$(dirname "$WEB_DIST_TARGET")"
  info "published -> $WEB_DIST_TARGET"
}

sync_nginx() {
  # A bad file here takes down every other site on this box, so the config is
  # staged, tested once, and restored on failure before anything is reloaded.
  local backup=""

  [ -f "$NGINX_REPO_CONF" ] || die "missing $NGINX_REPO_CONF"

  if [ -f "$NGINX_AVAILABLE" ] && sudo cmp -s "$NGINX_REPO_CONF" "$NGINX_AVAILABLE"; then
    info "nginx config already current"
    return 0
  fi

  if [ -f "$NGINX_AVAILABLE" ]; then
    backup="$NGINX_AVAILABLE.bak.$(date +%Y%m%d-%H%M%S)"
    sudo cp -a "$NGINX_AVAILABLE" "$backup"
    info "backed up live config -> $backup"
  fi

  sudo cp "$NGINX_REPO_CONF" "$NGINX_AVAILABLE"
  sudo ln -sfn "$NGINX_AVAILABLE" "/etc/nginx/sites-enabled/$SITE"

  if ! sudo nginx -t 2>"$LOG_DIR/nginx-t.log"; then
    if [ -n "$backup" ]; then
      sudo cp -a "$backup" "$NGINX_AVAILABLE"
    else
      sudo rm -f "$NGINX_AVAILABLE" "/etc/nginx/sites-enabled/$SITE"
    fi
    info "nginx -t failed; previous config restored"
    cat "$LOG_DIR/nginx-t.log" >&2
    die "nginx config rejected (see above); nothing was reloaded"
  fi

  # reload, not restart: other sites on this host keep serving.
  sudo systemctl reload nginx 2>/dev/null || sudo nginx -s reload
  info "nginx reloaded"
}

# ---------------------------------------------------------------- run it
say "building (parallel stages: infra, web, deps)"
[ "$DO_INFRA" = 1 ] && start_stage infra     stage_infra
[ "$DO_WEB"   = 1 ] && start_stage web-build stage_web_build
[ "$DO_API"   = 1 ] && start_stage deps      stage_deps

[ "$DO_INFRA" = 1 ] && await_stage infra
[ "$DO_WEB"   = 1 ] && await_stage web-build
[ "$DO_API"   = 1 ] && await_stage deps

if [ "$DO_API" = 1 ]; then
  say "database: waiting for postgres, then migrating"
  [ "$DO_INFRA" = 1 ] && wait_for_postgres && ok "postgres accepting connections"
  # Migrate BEFORE the restart so new code never briefly serves an old schema.
  ( cd "$REPO_ROOT/backend" && bun run db:migrate ) | sed 's/^/    /'
  ok "migrations applied"
fi

# Cutover order is api -> nginx -> web, not the other way round. The new bundle
# calls /api on this same origin, so it goes live LAST, once the API is serving
# and nginx has a route to it. Adding the /api block while the old bundle is
# still published is harmless.
if [ "$DO_API" = 1 ]; then
  say "api + worker: (re)starting ${PM2_APPS[*]}"
  # delete-then-start, scoped BY NAME: pm2 keeps the exec_mode and interpreter
  # an app was created with, so a reload would silently ignore changes to
  # ecosystem.config.cjs. Never `pm2 restart all` -- this box runs unrelated
  # apps (diudara-api, task-api, planner-backend and others) under the same pm2.
  for app in "${PM2_APPS[@]}"; do
    pm2 delete "$app" >/dev/null 2>&1 || true
  done
  ( cd "$REPO_ROOT" && pm2 start "$ECOSYSTEM" --update-env ) | sed 's/^/    /'
  pm2 save >/dev/null 2>&1 || true
  ok "api and worker started"
fi

if [ "$DO_NGINX" = 1 ]; then
  say "nginx: syncing site config"
  sync_nginx
  ok "nginx in sync"
fi

if [ "$DO_WEB" = 1 ]; then
  say "publishing frontend -> $WEB_DIST_TARGET"
  publish_web
  ok "web bundle published"
fi

# -------------------------------------------------------------- verify
# A deploy isn't done because the commands exited 0 — it's done when it serves.
say "verifying"
FAILED=0
check() { # label, expected, actual
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else printf "    \033[31mFAIL\033[0m %s (want %s, got %s)\n" "$1" "$2" "$3"; FAILED=1; fi
}
http_code() { local c; c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true)"; echo "${c:-000}"; }

if [ "$DO_API" = 1 ]; then
  # Poll rather than sleep once: pm2 reports "online" the instant it forks, well
  # before the process has bound the port — and it reports "online" for a
  # process that is crashlooping, too. Only /api/health proves it is serving.
  api_code=000
  for _ in $(seq 1 15); do
    api_code="$(http_code "http://127.0.0.1:$API_PORT/api/health")"
    [ "$api_code" = 200 ] && break
    sleep 1
  done
  check "api /api/health (direct :$API_PORT)" 200 "$api_code"

  # The API answering says nothing about the worker, which is a separate process
  # with its own way to fail (venv, ffmpeg, DB). pm2 is the only signal we have
  # without enqueuing a real job.
  worker_status="$(pm2 jlist 2>/dev/null | grep -o '"name":"clip-worker".*' | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)"
  check "worker process" "online" "${worker_status:-missing}"
fi

if [ "$DO_NGINX" = 1 ] || [ "$DO_WEB" = 1 ]; then
  check "$SITE / serves the SPA" 200 "$(http_code "https://$SITE/")"

  # 401 is the PASS: no cookie, no projects. This is the gate that replaced
  # nginx's basic auth, and a 200 here would mean every visitor can read and
  # queue jobs -- so it is checked on every deploy.
  check "$SITE /api/projects refuses without a session" 401 \
    "$(http_code "https://$SITE/api/projects")"

  # Sign-in must be reachable without one, and must actually bounce to Google.
  check "$SITE /api/auth/google redirects to Google" 302 \
    "$(http_code "https://$SITE/api/auth/google")"
  google_target="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 10 "https://$SITE/api/auth/google" || true)"
  case "$google_target" in
    https://accounts.google.com/*) ok "$SITE sign-in points at Google" ;;
    *) printf "    \033[31mFAIL\033[0m %s /api/auth/google went to '%s'\n" "$SITE" "$google_target"; FAILED=1 ;;
  esac

  # The one that proves the /api proxy block works: this must be JSON from the
  # API, not the SPA's index.html.
  api_probe="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "https://$SITE/api/health" || echo "000 none")"
  case "$api_probe" in
    200*application/json*) ok "$SITE /api via nginx (JSON)" ;;
    502*) printf "    \033[31mFAIL\033[0m %s /api: 502 — nginx routes correctly but the API is not answering on :%s (pm2 logs clip-api)\n" "$SITE" "$API_PORT"; FAILED=1 ;;
    *) printf "    \033[31mFAIL\033[0m %s /api returned '%s' — falling through to the SPA\n" "$SITE" "$api_probe"; FAILED=1 ;;
  esac
fi

say "done in $((SECONDS - START_TS))s"
pm2 list 2>/dev/null | grep -E "name|clip-api|clip-worker" || true

if [ "$FAILED" -ne 0 ]; then
  echo ""
  die "deploy finished but verification failed (logs: $LOG_DIR)"
fi
rm -rf "$LOG_DIR"
trap - EXIT
