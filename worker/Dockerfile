# Worker Dockerfile for Clip
# Base image needs Bun, Python 3.11+, ffmpeg, yt-dlp, and python wheels for transcription & autocrop

FROM oven/bun:1.2-slim AS base

# Install OS packages (ffmpeg, curl, python3, pip, venv)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp binary directly to guarantee fresh release
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Setup Python virtual environment
ENV VIRTUAL_ENV=/app/worker/.venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Install Python dependencies
COPY worker/python/requirements.txt /app/worker/python/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/worker/python/requirements.txt

# Download MediaPipe face landmarker model if not present
RUN curl -sSL -o /app/worker/python/face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

# Copy package manifests for workspace install
COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY worker/package.json ./worker/
COPY frontend/package.json ./frontend/

# Install Bun workspace dependencies
RUN bun install --frozen-lockfile

# Copy source files
COPY shared ./shared
COPY worker ./worker

WORKDIR /app/worker

CMD ["bun", "run", "src/index.ts"]
