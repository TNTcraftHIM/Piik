"""Build Film C's soundtrack (沙发够长 · PLENTY OF ROOM, 9:16) from films/C/cues.json.

    Piik-PV/.venv/Scripts/python.exe Piik-PV/audio/C/build.py

Writes out/C/audio/{music,sfx,voice,mix}.wav (48 kHz / 24-bit / stereo / exactly 20.000 s) plus events.json,
report.txt, spectrogram.png, rms.png. Deterministic.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]  # Piik-PV
sys.path.insert(0, str(ROOT / "audio"))
sys.path.insert(0, str(HERE))

from engine import fx  # noqa: E402
from engine.film import FilmMix, build, default_process  # noqa: E402
import score  # noqa: E402


def process(name, x):
    if name in ("saw", "sawd"):
        x = fx.eq(x, [("peak", 350.0, -2.5, 0.9), ("high", 8500.0, 2.5, 0.7)])
        return fx.widen(fx.lp(x, 13000.0), 1.15)
    if name == "pluck":
        return fx.hp(x, 200.0)
    if name == "musicbox":
        return fx.hp(x, 400.0)
    if name == "chop":
        x = fx.hp(fx.lp(x, 10000.0), 250.0)
        return fx.comp(x, threshold_db=-18.0, ratio=2.5, attack_ms=3.0, release_ms=60.0)
    return default_process(name, x)


MIX = FilmMix(
    title="Film C — 沙发够长 · PLENTY OF ROOM",
    length=20.0,
    swing=0.5,
    # track gains (dB) — tuned against the per-track RMS / band balance / SFX-margin tables in report.txt
    gains={"kick": -4.0, "snare": -8.0, "clap": -7.0, "hat": -6.0, "shaker": -13.0, "cym": -12.0,
           "bass808": -2.0, "bass808b": -6.5, "saw": 0.0, "sawd": 3.0, "pluck": -6.0, "musicbox": -8.0, "chop": -1.0},
    send_room={"clap": -12.0, "snare": -12.0},
    send_plate={"saw": -16.0, "sawd": -16.0, "pluck": -12.0, "musicbox": -9.0, "chop": -11.0},
    send_delay={"chop": -14.0, "musicbox": -12.0},
    delay_beats=0.75,
    sidechain={"saw": 8.0, "sawd": 8.0, "bass808": 2.0, "pluck": 2.0},
    sc_hold=0.01,
    sc_release=0.2,
    line_duck_db=4.0,
    sfx_duck_db=2.0,
    sfx_bus_db=0.0,
    voice_bus_db=5.0,
    fade=(18.6, 19.95),
    sfx_level={"firework_pop": -2},
    hit_tracks=("kick", "saw", "sawd", "clap", "snare"),
    process=process,
    chords=score.CHORDS,
    voice_engine="animalese",    # language-neutral voices: one track for zh + en subtitles
    film_id="C",
    ceiling_dbtp=-2.2,           # headroom so AAC/Opus web encodes stay <= -1.5 dBTP without losing loudness
)

if __name__ == "__main__":
    info = build(ROOT / "films" / "C" / "cues.json", ROOT / "out" / "C" / "audio", score.compose, MIX)
    print(f"done in {info['render_s']:.1f}s  LUFS {info['lufs']:.2f}  TP {info['true_peak_dbtp']:.2f} dBTP")
