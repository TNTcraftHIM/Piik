"""Build Film F's soundtrack (出金了！ · GOLD!, 9:16) from films/F/cues.json.

    Piik-PV/.venv/Scripts/python.exe Piik-PV/audio/F/build.py

Writes out/F/audio/{music,sfx,voice,mix}.wav (48 kHz / 24-bit / stereo / exactly 36.000 s) plus events.json,
report.txt, spectrogram.png, rms.png, then the web encodes (web.webm Opus + web.m4a AAC, checked by
audio/web_export.py: exact length, -14 LUFS, <= -1.5 dBTP). Deterministic. Voices are animalese (language-neutral),
so one soundtrack serves the zh and en cuts; the four screams at [15,1] start on the same sample.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]  # Piik-PV
sys.path.insert(0, str(ROOT / "audio"))
sys.path.insert(0, str(HERE))

from engine import fx  # noqa: E402
from engine.film import FilmMix, build, default_process  # noqa: E402
import sfx_f  # noqa: E402,F401  (registers the f_* sounds)
import score  # noqa: E402


def process(name, x):
    if name in ("saw", "sawd"):
        x = fx.eq(x, [("peak", 350.0, -2.5, 0.9), ("high", 8500.0, 2.5, 0.7)])
        return fx.widen(fx.lp(x, 13000.0), 1.15)
    if name == "stab":
        x = fx.hp(x, 220.0)
        x = fx.eq(x, [("peak", 450.0, -2.0, 1.0), ("peak", 2400.0, 1.5, 1.0)])
        return fx.lp(x, 9000.0)
    if name == "pad":
        return fx.hp(x, 160.0)
    if name in ("pluck", "glitch"):
        return fx.hp(x, 220.0)
    if name == "musicbox":
        return fx.hp(x, 400.0)
    if name == "chop":
        x = fx.hp(fx.lp(x, 10000.0), 250.0)
        return fx.comp(x, threshold_db=-18.0, ratio=2.5, attack_ms=3.0, release_ms=60.0)
    return default_process(name, x)


MIX = FilmMix(
    title="Film F — 出金了！ · GOLD!",
    length=36.0,
    swing=0.52,
    # track gains (dB) — tuned against the per-track RMS / band balance / SFX-margin tables in report.txt
    gains={"kick": -4.0, "snare": -9.0, "clap": -7.5, "hat": -9.0, "ohat": -12.0, "shaker": -14.0, "cym": -12.0,
           "bass": -7.0, "bass808": -3.0, "stab": -9.0, "saw": -1.0, "sawd": 2.0, "pad": -11.0, "pluck": -9.0,
           "musicbox": -9.0, "chop": -3.0, "glitch": -13.0},
    send_room={"clap": -12.0, "snare": -13.0},
    send_plate={"saw": -16.0, "sawd": -16.0, "stab": -15.0, "pad": -10.0, "pluck": -12.0, "musicbox": -9.0, "chop": -11.0},
    send_delay={"chop": -14.0, "pluck": -16.0, "glitch": -12.0},
    delay_beats=0.75,
    sidechain={"saw": 7.0, "sawd": 8.0, "pad": 4.0, "stab": 2.0, "bass": 2.0, "bass808": 2.0},
    sc_hold=0.01,
    sc_release=0.18,
    line_duck_db=4.0,
    line_duck_extra={"exclaim": -4.0, "laugh": -1.5, "excited": 1.5},   # the screams ride the drop instead of ducking it
    voice_gain={"exclaim": 2.0, "laugh": 0.5, "excited": 1.5},
    sfx_duck_db=2.0,
    sfx_bus_db=0.0,
    voice_bus_db=5.0,
    fade=(34.9, 35.95),
    sfx_level={"firework_pop": -4, "danmaku_tick": 0, "pop_friend": -5, "counter_tick": -9, "window_pop": -7,
               "crowd_cheer": -7, "rainbow_shimmer": -6, "label_tick": -6, "edit_glitch": -6, "row_decode": -1,
               "panel_slide": -2, "f_deal": -3},
    hit_tracks=("kick", "sawd", "clap", "snare", "stab"),
    process=process,
    chords=score.CHORDS,
    voice_engine="animalese",    # language-neutral voices: one track for zh + en subtitles
    film_id="F",
    ceiling_dbtp=-2.3,           # headroom so the AAC/Opus web encodes stay <= -1.5 dBTP without losing loudness
)

if __name__ == "__main__":
    info = build(ROOT / "films" / "F" / "cues.json", ROOT / "out" / "F" / "audio", score.compose, MIX)
    print(f"done in {info['render_s']:.1f}s  LUFS {info['lufs']:.2f}  TP {info['true_peak_dbtp']:.2f} dBTP")
    if "--no-web" not in sys.argv:
        r = subprocess.run([sys.executable, str(ROOT / "audio" / "web_export.py"), "F"], capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip())
