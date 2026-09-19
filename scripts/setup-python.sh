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

command -v python3 >/dev/null 2>&1 || { echo "python3 not found." >&2; exit 1; }
command -v ffmpeg  >/dev/null 2>&1 || { echo "ffmpeg not found. sudo apt install ffmpeg" >&2; exit 1; }

if [ ! -d "$VENV" ]; then
  echo "==> Creating venv at $VENV"
  python3 -m venv "$VENV"
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
echo "    bun --cwd worker run dev"
echo
echo "Check it resolved:"
"$VENV/bin/whisper-ctranslate2" --help >/dev/null 2>&1 \
  && echo "    whisper-ctranslate2  OK" \
  || echo "    whisper-ctranslate2  NOT WORKING"
"$VENV/bin/python" -c 'import mediapipe' 2>/dev/null \
  && echo "    mediapipe            OK" \
  || echo "    mediapipe            NOT WORKING (renders fall back to centre crop)"
