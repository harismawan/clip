#!/usr/bin/env python3
"""
Reframe landscape clips to 9:16 (TikTok) and follow the active speaker.

Pipeline (per clip):
  1. Probe size / fps / duration with ffprobe.
  2. Extract a mono audio RMS envelope (when there is speech).
  3. Decode low-res frames at a low fps and run MediaPipe FaceMesh to find
     every face + how much each mouth is moving.
  4. Track faces across frames; the "active speaker" is the visible face whose
     mouth moves while there is audio. Falls back to the most central face.
  5. Lock the crop onto the active speaker: hold it perfectly still and only
     cut (snap) to a new position when the speaker changes or moves past a
     deadzone, so little head movements are ignored.
  6. Render the final vertical video by letting ffmpeg do a time-varying crop
     (via the sendcmd filter) -> fast, no per-frame Python decode/encode.

Run with the project venv:  .venv/bin/python autocrop.py
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

import numpy as np

os.environ.setdefault("GLOG_minloglevel", "2")  # silence MediaPipe C++ logs
import mediapipe as mp  # noqa: E402
from mediapipe.tasks import python as mp_python  # noqa: E402
from mediapipe.tasks.python import vision  # noqa: E402

# FaceLandmarker landmark indices (same 468-point topology as FaceMesh)
LIP_TOP, LIP_BOTTOM = 13, 14          # inner lip centre (mouth openness)
FACE_TOP, FACE_BOTTOM = 10, 152       # forehead / chin (normalise by face height)

# Model file (auto-downloaded by setup; see README at bottom of this file)
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "face_landmarker.task")

# VIDEO_ENCODER=nvenc: the same switch the worker's ffmpeg.ts reads (see the
# measurements there -- it is slower than libx264 unless the CPU is the scarce
# resource). MediaPipe stays on the CPU: its Python GPU delegate is not
# supported on Linux, and it only sees a 480px frame at 5fps anyway.
NVENC = os.environ.get("VIDEO_ENCODER") == "nvenc"


def h264_args(preset, crf):
    if NVENC:
        # x264 presets mean nothing to NVENC; p4 is its balanced default.
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr",
                "-cq", str(crf), "-b:v", "0", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p"]


# ----------------------------------------------------------------------------
# ffprobe / ffmpeg helpers
# ----------------------------------------------------------------------------
def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-show_entries", "format=duration",
         "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    info = json.loads(out)
    st = info["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    fps = float(num) / float(den) if float(den) else 24.0
    return int(st["width"]), int(st["height"]), fps, float(info["format"]["duration"])


def audio_energy(path, n_frames, analysis_fps):
    """Per-analysis-frame RMS envelope, normalised to [0, 1]."""
    sr = 16000
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path,
         "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout
    if not raw:
        return np.zeros(n_frames)
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    win = max(1, sr // analysis_fps)
    env = np.zeros(n_frames)
    for i in range(n_frames):
        seg = audio[i * win:(i + 1) * win]
        if seg.size:
            env[i] = float(np.sqrt(np.mean(seg ** 2)))
    peak = env.max()
    return env / peak if peak > 0 else env


# ----------------------------------------------------------------------------
# Face analysis
# ----------------------------------------------------------------------------
def analyze(path, analysis_fps, src_w, src_h, max_faces):
    """Decode low-res frames; return a list (one per frame) of tracked faces.

    Each entry is a list of dicts {cx, cy, motion} in normalised [0,1] coords.
    """
    a_w = 480
    a_h = int(round(src_h * a_w / src_w / 2) * 2)

    proc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path,
         "-vf", f"fps={analysis_fps},scale={a_w}:{a_h}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    frame_bytes = a_w * a_h * 3

    options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=max_faces,
    )
    mesh = vision.FaceLandmarker.create_from_options(options)
    ts_ms = 0
    step_ms = int(round(1000 / analysis_fps))

    tracks = []        # {cx, cy, last_open, motion, missed}
    per_frame = []

    while True:
        buf = proc.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        frame = np.ascontiguousarray(
            np.frombuffer(buf, np.uint8).reshape(a_h, a_w, 3))
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame)
        res = mesh.detect_for_video(mp_image, ts_ms)
        ts_ms += step_ms

        dets = []
        if res.face_landmarks:
            for pts in res.face_landmarks:
                xs = [p.x for p in pts]
                ys = [p.y for p in pts]
                cx = (min(xs) + max(xs)) / 2
                cy = (min(ys) + max(ys)) / 2
                face_h = abs(pts[FACE_TOP].y - pts[FACE_BOTTOM].y) + 1e-6
                openness = abs(pts[LIP_TOP].y - pts[LIP_BOTTOM].y) / face_h
                dets.append({"cx": cx, "cy": cy, "open": openness})

        # match detections to existing tracks by nearest centre
        used = set()
        for d in dets:
            best, bestd = -1, 0.12
            for ti, t in enumerate(tracks):
                if ti in used:
                    continue
                dist = abs(t["cx"] - d["cx"]) + abs(t["cy"] - d["cy"])
                if dist < bestd:
                    best, bestd = ti, dist
            if best >= 0:
                t = tracks[best]
                motion = abs(d["open"] - t["last_open"])
                t.update(cx=d["cx"], cy=d["cy"], last_open=d["open"], missed=0)
                t["motion"] = 0.5 * t["motion"] + 0.5 * motion
                used.add(best)
            else:
                tracks.append({"cx": d["cx"], "cy": d["cy"], "last_open": d["open"],
                               "motion": 0.0, "missed": 0})
                used.add(len(tracks) - 1)

        for ti, t in enumerate(tracks):
            if ti not in used:
                t["missed"] += 1
        tracks = [t for t in tracks if t["missed"] <= 3]

        per_frame.append([{"cx": t["cx"], "cy": t["cy"], "motion": t["motion"]}
                          for t in tracks if t["missed"] == 0])

    proc.wait()
    mesh.close()
    return per_frame


# ----------------------------------------------------------------------------
# Speaker decision + smoothing
# ----------------------------------------------------------------------------
def decide_centers(frames, energy, audio_thresh, min_motion):
    n = len(frames)
    target = np.full(n, np.nan)
    last = None
    for i in range(n):
        tracks = frames[i]
        if not tracks:
            target[i] = last if last is not None else np.nan
            continue
        audio_on = energy[i] > audio_thresh if i < len(energy) else True
        speaker = None
        if audio_on:
            cand = max(tracks, key=lambda t: t["motion"])
            if cand["motion"] >= min_motion:
                speaker = cand
        if speaker is None:
            # no clear talker: hold previous subject, else most central face
            if last is not None:
                speaker = min(tracks, key=lambda t: abs(t["cx"] - last))
            else:
                speaker = min(tracks, key=lambda t: abs(t["cx"] - 0.5))
        target[i] = speaker["cx"]
        last = target[i]
    return target


def lock_onto_speaker(target, deadzone):
    """Snap the crop to the active speaker and hold it steady.

    No gliding: the crop stays put and only jumps (a hard cut) to a new
    position when the speaker's centre moves more than `deadzone` (fraction of
    width) from where we're locked. Small head/body movements inside the
    deadzone are ignored, so the framing on one person never drifts.
    """
    n = len(target)
    if n == 0:
        return target
    idx = np.arange(n)
    good = ~np.isnan(target)
    if not good.any():
        return np.full(n, 0.5)
    target = np.interp(idx, idx[good], target[good])

    out = np.empty(n)
    locked = target[0]
    out[0] = locked
    for i in range(1, n):
        if abs(target[i] - locked) > deadzone:
            locked = target[i]      # cut to the new speaker / position
        out[i] = locked
    return out


# ----------------------------------------------------------------------------
# Render
# ----------------------------------------------------------------------------
def escape_filter_path(p):
    """ffmpeg's filtergraph parser treats : , ' \\ as structure, so an unescaped
    path silently yields a broken graph rather than an error."""
    return p.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def render(path, out_path, centers_frac, analysis_fps, src_w, src_h,
           out_w, out_h, crf, preset, subtitles=None, sub_style=None):
    crop_w = int(round(src_h * out_w / out_h))
    crop_w += crop_w % 2
    crop_w = min(crop_w, src_w)

    # build sendcmd command list: set crop x whenever it changes
    lines, prev_x = [], None
    for i, c in enumerate(centers_frac):
        t = i / analysis_fps
        x = int(round(c * src_w - crop_w / 2))
        x = max(0, min(x, src_w - crop_w))
        if x != prev_x:
            lines.append(f"{t:.3f} crop x {x};")
            prev_x = x

    with tempfile.NamedTemporaryFile("w", suffix=".cmd", delete=False) as f:
        f.write("\n".join(lines) + "\n")
        cmd_file = f.name

    if len(centers_frac):
        x0 = max(0, min(int(round(centers_frac[0] * src_w - crop_w / 2)),
                        src_w - crop_w))
    else:
        x0 = (src_w - crop_w) // 2

    # Subtitles are burned AFTER the scale: the ASS file declares PlayRes equal
    # to the output size, so burning before the scale would resize text with it.
    # Doing it here rather than in a second ffmpeg pass avoids a whole extra
    # re-encode (double the render time, one generation of quality) just to add text.
    sub_filter = ""
    if subtitles:
        style = f":force_style='{sub_style}'" if sub_style else ""
        sub_filter = f",subtitles='{escape_filter_path(subtitles)}'{style}"

    vf = (f"[0:v]sendcmd=f='{cmd_file}',"
          f"crop={crop_w}:ih:{x0}:0,scale={out_w}:{out_h}{sub_filter},setsar=1[v]")

    cmd = ["ffmpeg", "-nostdin", "-y", "-v", "error", "-stats", "-i", path,
           "-filter_complex", vf, "-map", "[v]", "-map", "0:a?",
           *h264_args(preset, crf),
           "-c:a", "aac", "-b:a", "128k",
           "-movflags", "+faststart", out_path]
    try:
        subprocess.run(cmd, check=True)
    finally:
        os.unlink(cmd_file)


# ----------------------------------------------------------------------------
# Progress / timing
# ----------------------------------------------------------------------------
def fmt_time(seconds):
    """Seconds -> 'M:SS' or 'H:MM:SS'."""
    seconds = int(round(max(0, seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def progress_bar(frac, width=24):
    frac = min(1.0, max(0.0, frac))
    filled = int(round(frac * width))
    return "█" * filled + "░" * (width - filled)


def video_duration(path):
    """Quick duration probe (seconds), 0.0 if unknown."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


# ----------------------------------------------------------------------------
def process(path, out_dir, args):
    if getattr(args, "out_file", None):
        out_path = args.out_file
    else:
        name = os.path.splitext(os.path.basename(path))[0]
        out_path = os.path.join(out_dir, name + ".mp4")
    src_w, src_h, fps, dur = probe(path)
    print(f"  {src_w}x{src_h} @ {fps:.2f}fps, {dur:.1f}s")

    frames = analyze(path, args.analysis_fps, src_w, src_h, args.max_faces)
    n = len(frames)
    if n == 0:
        print("  ! no frames decoded, skipping")
        return
    energy = audio_energy(path, n, args.analysis_fps)
    if not any(frames):
        print("  ! no faces found -> static centre crop")
        centers = np.full(n, 0.5)
    else:
        target = decide_centers(frames, energy, args.audio_thresh, args.min_motion)
        centers = lock_onto_speaker(target, args.deadzone)

    render(path, out_path, centers, args.analysis_fps, src_w, src_h,
           args.out_w, args.out_h, args.crf, args.preset,
           getattr(args, "subtitles", None), getattr(args, "sub_style", None))
    print(f"  -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description="Reframe clips to 9:16 following the speaker.")
    ap.add_argument("inputs", nargs="*", help="Video files (default: all in clips/)")
    ap.add_argument("-i", "--indir", default="clips", help="Input dir if no files given")
    ap.add_argument("-o", "--outdir", default="vertical", help="Output dir")
    ap.add_argument("--out-w", type=int, default=1080)
    ap.add_argument("--out-h", type=int, default=1920)
    ap.add_argument("--analysis-fps", type=int, default=5, help="Tracking sample rate")
    ap.add_argument("--max-faces", type=int, default=3)
    ap.add_argument("--deadzone", type=float, default=0.06,
                    help="How far (fraction of width) the speaker must move "
                         "before the crop cuts to them; smaller = more reactive")
    ap.add_argument("--audio-thresh", type=float, default=0.08,
                    help="Audio level (0..1) above which speech is 'active'")
    ap.add_argument("--min-motion", type=float, default=0.004,
                    help="Mouth motion needed to count as speaking")
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--preset", default="veryfast")
    # Single-file mode, used by the worker: one clip in, one exact path out.
    ap.add_argument("--out-file", default=None,
                    help="Write to this exact path instead of outdir/<name>.mp4 "
                         "(single input only)")
    ap.add_argument("--subtitles", default=None,
                    help="SRT/ASS file to burn in, with times relative to this clip")
    ap.add_argument("--sub-style", default=None,
                    help="ffmpeg force_style string for the burned subtitles")
    args = ap.parse_args()

    if args.out_file and len(args.inputs) > 1:
        print("--out-file takes a single input file.", file=sys.stderr)
        sys.exit(1)

    if args.inputs:
        files = args.inputs
    else:
        d = args.indir
        files = sorted(os.path.join(d, f) for f in os.listdir(d)
                       if f.lower().endswith((".webm", ".mp4", ".mkv", ".mov")))
    if not files:
        print("No input files found.", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(MODEL_PATH):
        print(f"Missing model file: {MODEL_PATH}\n"
              "Download it once with:\n"
              "  curl -sSL -o face_landmarker.task "
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
              "face_landmarker/float16/1/face_landmarker.task",
              file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)

    # Weight progress / ETA by total video seconds (longer clips take longer).
    durations = [video_duration(p) for p in files]
    total_dur = sum(durations) or 1.0
    done_dur = 0.0
    t0 = time.monotonic()

    for i, path in enumerate(files, 1):
        elapsed = time.monotonic() - t0
        frac = done_dur / total_dur
        eta = elapsed * (total_dur - done_dur) / done_dur if done_dur > 0 else None
        eta_str = fmt_time(eta) if eta is not None else "--:--"
        print(f"\n[{i}/{len(files)}] {progress_bar(frac)} {frac * 100:3.0f}%  "
              f"elapsed {fmt_time(elapsed)} · eta {eta_str}")
        print(f"  {os.path.basename(path)}")
        try:
            process(path, args.outdir, args)
        except subprocess.CalledProcessError as e:
            print(f"  ! ffmpeg failed: {e}", file=sys.stderr)
        except Exception as e:
            print(f"  ! error: {e}", file=sys.stderr)
        done_dur += durations[i - 1]

    total_elapsed = time.monotonic() - t0
    print(f"\n[{len(files)}/{len(files)}] {progress_bar(1.0)} 100%  "
          f"done in {fmt_time(total_elapsed)}")


if __name__ == "__main__":
    main()
