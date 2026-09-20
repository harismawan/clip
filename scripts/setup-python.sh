#!/usr/bin/env bash
#
# One-time setup of the worker's Python side: transcription (whisper-ctranslate2)
# and speaker-tracking reframe (MediaPipe).
#
#   ./scripts/setup-python.sh
#
# Both are CLI tools the worker shells out to, exactly like ffmpeg and yt-dlp --
# Python is an implementation detail of two binaries, not a runtime dependency
# of the worker itself.
set -euo pipefail

cd "$(dirname "$0")/.."

VENV="worker/.venv"
MODEL="worker/python/face_landmarker.task"

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found. sudo apt install ffmpeg" >&2; exit 1; }

# numpy 2.4 needs Python 3.11+, which is newer than the python3 some distros
# still ship as the default. Take $PYTHON if set, else the newest one we find.
usable() {
  command -v "$1" >/dev/null 2>&1 \
    && "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null
}

if [ -n "${PYTHON:-}" ]; then
  usable "$PYTHON" || { echo "PYTHON=$PYTHON is not Python 3.11+." >&2; exit 1; }
else
  for candidate in python3.14 python3.13 python3.12 python3.11 python3; do
    if usable "$candidate"; then PYTHON="$candidate"; break; fi
  done
  [ -n "${PYTHON:-}" ] || {
    echo "No Python 3.11+ found (the pinned numpy needs it)." >&2
    echo "  sudo apt install python3.12 python3.12-venv" >&2
    echo "Then re-run, or point at one: PYTHON=/path/to/python3.12 $0" >&2
    exit 1
  }
fi
echo "==> Using $("$PYTHON" -V) from $(command -v "$PYTHON")"

# An interrupted run leaves the venv skeleton behind without pip, and a bare
# -d test would skip creation forever. Rebuild unless the venv is complete and
# built against a new enough interpreter.
if ! "$VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null \
  || ! "$VENV/bin/pip" --version >/dev/null 2>&1; then
  if [ -e "$VENV" ]; then
    echo "==> Removing incomplete or outdated venv at $VENV"
    rm -rf "$VENV"
  fi
  echo "==> Creating venv at $VENV"
  "$PYTHON" -m venv "$VENV"
fi

echo "==> Installing Python dependencies (this pulls ~400MB of wheels)"
"$VENV/bin/pip" install --upgrade pip --quiet
"$VENV/bin/pip" install -r worker/python/requirements.txt

if [ ! -f "$MODEL" ]; then
  echo "==> Downloading the MediaPipe face landmarker model"
  curl -sSL -o "$MODEL" \
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
fi

echo
echo "Done. Add the venv to PATH before starting the worker:"
echo
echo "    export PATH=\"\$PWD/$VENV/bin:\$PATH\""
echo "    bun --cwd=worker run dev"
echo
echo "Check it resolved:"
"$VENV/bin/whisper-ctranslate2" --help >/dev/null 2>&1 \
  && echo "    whisper-ctranslate2  OK" \
  || echo "    whisper-ctranslate2  NOT WORKING"
"$VENV/bin/python" -c 'import mediapipe' 2>/dev/null \
  && echo "    mediapipe            OK" \
  || echo "    mediapipe            NOT WORKING (renders fall back to centre crop)"
