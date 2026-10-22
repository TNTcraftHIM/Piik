"""Compact web audio for a film: Opus/WebM + AAC-LC/M4A from out/<ID>/audio/mix.wav, verified by decoding.

    Piik-PV/.venv/Scripts/python.exe Piik-PV/audio/web_export.py A C

For each encode: decode back with ffmpeg, check the sample count equals the master (exact film length), measure
integrated loudness (target -14 LUFS) and 4x-oversampled true peak (must be <= -1.5 dBTP). The masters carry
-2.25 dBTP of headroom so no pre-encode gain should be needed; if an encode still overshoots, a small negative
pre-encode gain is applied and reported (fix the master ceiling instead if that ever happens).
Writes out/<ID>/audio/web.webm, web.m4a and web_report.txt.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from engine.core import SR, read_wav  # noqa: E402
from engine import fx  # noqa: E402

TARGET_LUFS = -14.0
MAX_TP = -1.5
CODECS = {
    "web.webm": ["-c:a", "libopus", "-b:a", "112k", "-vbr", "constrained", "-compression_level", "10",
                 "-application", "audio", "-frame_duration", "20"],
    "web.m4a": ["-c:a", "aac", "-b:a", "160k", "-profile:a", "aac_low", "-aac_coder", "twoloop",
                "-movflags", "+faststart"],
}


def encode(src: Path, dst: Path, args, gain_db: float):
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src)]
    if gain_db:
        cmd += ["-af", f"volume={gain_db:.2f}dB"]
    cmd += ["-ar", "48000", "-ac", "2", "-map_metadata", "-1"] + args + [str(dst)]
    subprocess.run(cmd, check=True)


def decode(path: Path, seconds: float | None = None) -> np.ndarray:
    """Decode to float32 stereo. `seconds` trims like a player honouring the container duration (AAC's last frame
    is padded to 1024 samples; the M4A edit list/stts carry the exact length, raw ffmpeg decoding does not trim)."""
    cmd = ["ffmpeg", "-v", "error", "-i", str(path)]
    if seconds is not None:
        cmd += ["-t", f"{seconds:.6f}"]
    raw = subprocess.run(cmd + ["-f", "f32le", "-ac", "2", "-ar", "48000", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def container_samples(path: Path) -> int | None:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts",
                          "-of", "csv=p=0", str(path)], check=True, capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() else None


def export(film: str) -> list[str]:
    adir = ROOT / "out" / film / "audio"
    src = adir / "mix.wav"
    master = read_wav(src)
    lines = [f"web audio — film {film}: master {master.shape[0]} samples ({master.shape[0] / SR:.3f} s), "
             f"{fx.lufs(master):.2f} LUFS, {fx.true_peak_db(master):.2f} dBTP"]
    for name, args in CODECS.items():
        dst = adir / name
        gain = 0.0
        for _ in range(4):
            encode(src, dst, args, gain)
            raw_len = decode(dst).shape[0]
            dec = decode(dst, master.shape[0] / SR)
            L, tp = fx.lufs(dec), fx.true_peak_db(dec)
            if tp <= MAX_TP:
                break
            gain -= (tp - MAX_TP) + 0.1
        cont = container_samples(dst)
        n_play = cont if cont else raw_len           # what a player renders: container length when it has one
        same_len = n_play == master.shape[0]
        kb = dst.stat().st_size / 1024
        rate = dst.stat().st_size * 8 / (master.shape[0] / SR) / 1000
        note = f"container {cont} samples, raw decode {raw_len}" if cont else f"decoded {raw_len} samples"
        lines.append(f"  {name:9s} {kb:7.0f} KB (~{rate:.0f} kbps)  {note} "
                     f"({'exact length' if same_len else 'LENGTH MISMATCH'})  {L:6.2f} LUFS  TP {tp:6.2f} dBTP"
                     f"  pre-encode gain {gain:+.2f} dB")
    (adir / "web_report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return lines


if __name__ == "__main__":
    for f in sys.argv[1:] or ["A", "C"]:
        print("\n".join(export(f)))
