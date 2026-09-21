#!/usr/bin/env bash
#
# Start SSH port forwarding tunnel to remote Postgres & MinIO infrastructure.
#
#   ./scripts/tunnel.sh         # start tunnel in background
#   ./scripts/tunnel.sh status  # check status
#   ./scripts/tunnel.sh stop    # stop active tunnel
#

set -euo pipefail

REMOTE_HOST="${TUNNEL_HOST:-103.127.98.119}"
REMOTE_USER="${TUNNEL_USER:-wildandev}"

is_running() {
  pgrep -f "ssh.*${REMOTE_HOST}" >/dev/null 2>&1
}

cmd="${1:-start}"

case "$cmd" in
  start)
    if is_running; then
      echo "==> Tunnel to ${REMOTE_USER}@${REMOTE_HOST} is already running."
    else
      echo "==> Starting tunnel to ${REMOTE_USER}@${REMOTE_HOST}..."
      ssh -N -f \
        -o "ExitOnForwardFailure=yes" \
        -o "ServerAliveInterval=30" \
        -o "ServerAliveCountMax=3" \
        -L 5445:127.0.0.1:5445 \
        -L 9020:127.0.0.1:9020 \
        -L 9021:127.0.0.1:9021 \
        "${REMOTE_USER}@${REMOTE_HOST}"
      echo "==> Tunnel started."
    fi

    # Verify local ports
    nc -z 127.0.0.1 5445 && echo "    Postgres (5445)  OK" || echo "    Postgres (5445)  FAILED"
    nc -z 127.0.0.1 9020 && echo "    MinIO    (9020)  OK" || echo "    MinIO    (9020)  FAILED"
    ;;

  status)
    if is_running; then
      echo "Tunnel: RUNNING"
      nc -z 127.0.0.1 5445 && echo "  Port 5445 (Postgres): CONNECTED" || echo "  Port 5445 (Postgres): CLOSED"
      nc -z 127.0.0.1 9020 && echo "  Port 9020 (MinIO)   : CONNECTED" || echo "  Port 9020 (MinIO)   : CLOSED"
    else
      echo "Tunnel: NOT RUNNING"
    fi
    ;;

  stop)
    if is_running; then
      pkill -f "ssh.*${REMOTE_HOST}" || true
      echo "==> Tunnel stopped."
    else
      echo "==> Tunnel is not running."
    fi
    ;;

  *)
    echo "Usage: $0 [start|status|stop]"
    exit 1
    ;;
esac
