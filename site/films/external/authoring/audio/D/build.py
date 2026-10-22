"""Build Film D's soundtrack (一起看，咔哒一下 · CLICK, AND WATCH TOGETHER) from films/D/cues.json.

    Piik-PV/.venv/Scripts/python.exe Piik-PV/audio/D/build.py

Writes out/D/audio/{music,sfx,voice,mix}.wav (48 kHz / 24-bit / stereo / exactly 52.000 s) plus events.json,
report.txt, spectrogram.png, rms.png, then the web encodes (web.webm Opus 112k + web.m4a AAC 160k, checked by
audio/web_export.py: exact length, -14 LUFS, <= -1.5 dBTP). Deterministic. Voices are animalese (language-neutral),
so one soundtrack serves the zh and en cuts.
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
import sfx_d  # noqa: E402,F401  (registers click_big, card_drop, chip_pop, stepper_tick, split_click, pong_*)
import score  # noqa: E402


def process(name, x):
    if name == "marimba":
        x = fx.eq(fx.hp(x, 180.0), [("peak", 3000.0, 3.0, 0.8)])
        return fx.lp(x, 10000.0)
    if name == "ep":
        return fx.eq(default_process(name, x), [("peak", 2600.0, 2.5, 0.9)])
    if name == "stab":
        x = fx.hp(x, 220.0)
        x = fx.eq(x, [("peak", 450.0, -2.0, 1.0)])
        return fx.lp(x, 8500.0)
    if name == "pad":
        return fx.hp(x, 140.0)
    if name == "whistle":
        x = fx.hp(x, 300.0)
        return fx.eq(x, [("peak", 1800.0, 1.0, 1.0)])
    if name == "glock":
        return fx.hp(x, 600.0)
    return default_process(name, x)


def post_main(main, grid):
    """Bright music-bus polish: a little less boxiness, a little more presence and air."""
    return fx.eq(main, [("peak", 320.0, -1.5, 0.9), ("high", 4500.0, 2.0, 0.7)])


MIX = FilmMix(
    title="Film D — 一起看，咔哒一下 · CLICK, AND WATCH TOGETHER",
    length=52.0,
    swing=0.52,
    # track gains (dB) — tuned against the per-track RMS / band balance / SFX-margin tables in report.txt
    gains={"kick": -6.5, "rim": -5.0, "shaker": -7.0, "hat": -6.0, "ohat": -8.0, "clap": -6.0, "snare": -8.0,
           "cym": -11.0, "bass": -6.0, "ep": -6.5, "marimba": -6.0, "glock": -8.0, "gtr": -4.0, "stab": -8.0,
           "pad": -9.0, "whistle": -12.0},
    send_room={"rim": -14.0, "clap": -12.0, "snare": -13.0, "marimba": -18.0},
    send_plate={"ep": -16.0, "marimba": -14.0, "glock": -9.0, "pad": -10.0, "whistle": -11.0, "stab": -15.0},
    send_delay={"whistle": -14.0, "marimba": -20.0, "glock": -15.0},
    delay_beats=0.75,
    sidechain={"bass": 1.5, "pad": 3.0, "ep": 1.0},
    line_duck_db=4.5,
    line_duck_extra={"excited": 1.5},
    voice_gain={"excited": 0.5},
    sfx_duck_db=1.5,
    sfx_bus_db=0.0,
    voice_bus_db=5.0,
    fade=(50.2, 51.95),
    sfx_level={"chip_pop": -6, "danmaku_tick": -1, "tile_flip": -1, "window_pop": -7, "chat_pop": -6,
               "send_whoosh": -6, "whoosh_short": -6, "paste_tick": -6, "live_on": -5, "sparkle": -8,
               "crowd_cheer": -9, "riser_short": -10, "request_chime": -7, "control_on": -6, "voice_on": -7,
               "ui_click": -6, "pop_friend": -6, "throw_whoosh": -5, "splat": -5, "poop_boing": -6, "label_blip": 1},
    hit_tracks=("kick", "stab", "clap", "marimba", "ep"),
    process=process,
    post_main=post_main,
    chords=score.CHORDS,
    voice_engine="animalese",    # language-neutral voices: one track for zh + en subtitles
    film_id="D",
    ceiling_dbtp=-2.3,           # headroom so the AAC/Opus web encodes stay <= -1.5 dBTP without losing loudness
)

if __name__ == "__main__":
    info = build(ROOT / "films" / "D" / "cues.json", ROOT / "out" / "D" / "audio", score.compose, MIX)
    print(f"done in {info['render_s']:.1f}s  LUFS {info['lufs']:.2f}  TP {info['true_peak_dbtp']:.2f} dBTP")
    if "--no-web" not in sys.argv:
        r = subprocess.run([sys.executable, str(ROOT / "audio" / "web_export.py"), "D"], capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip())
