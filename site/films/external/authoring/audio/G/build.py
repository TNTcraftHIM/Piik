"""Build Film G's soundtrack (作战会议 · MISSION BRIEFING) from films/G/cues.json.

    Piik-PV/.venv/Scripts/python.exe Piik-PV/audio/G/build.py

Writes out/G/audio/{music,sfx,voice,mix}.wav (48 kHz / 24-bit / stereo / exactly 46.000 s) plus events.json,
report.txt, spectrogram.png, rms.png, then the web encodes (web.webm Opus + web.m4a AAC, checked by
audio/web_export.py: exact length, -14 LUFS, <= -1.5 dBTP). Deterministic. Voices are animalese (language-neutral),
so one soundtrack serves the zh and en cuts. Film G's own sounds live in audio/engine/sfx_g.py.
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
from engine import sfx_g  # noqa: E402,F401  (registers g_string, g_pin, g_click, g_stamp*, g_check, g_marker, g_hit)
from engine.film import FilmMix, build, default_process  # noqa: E402
import score  # noqa: E402


def process(name, x):
    if name == "ride":
        x = fx.hp(x, 400.0)
        return fx.lp(x, 11000.0)
    if name == "glock":
        return fx.hp(x, 700.0)
    return default_process(name, x)


MIX = FilmMix(
    title="Film G — 作战会议 · MISSION BRIEFING",
    length=46.0,
    swing=0.56,
    # track gains (dB) — tuned against the per-track RMS / band balance / SFX-margin tables in report.txt
    gains={"kick": -6.0, "snare": -3.5, "clap": -9.0, "hat": -8.5, "ohat": -12.0, "shaker": -15.0, "rim": -8.0,
           "ride": -13.0, "cym": -12.0, "timp": -7.0, "bass": -4.5, "ep": -8.5, "gtr": -2.5, "brass": -6.0,
           "strings": -8.0, "glock": -14.0},
    send_room={"snare": -12.0, "clap": -10.0, "rim": -14.0},
    send_plate={"ep": -15.0, "brass": -12.0, "strings": -11.0, "glock": -8.0, "gtr": -17.0, "timp": -18.0},
    send_delay={"glock": -14.0},
    delay_beats=0.75,
    sidechain={"bass": 2.5, "ep": 1.5, "strings": 3.0, "gtr": 1.5},
    line_duck_db=4.0,
    line_duck_extra={"laugh": -1.0, "excited": 2.0},
    voice_gain={"laugh": -2.0, "excited": 1.0},
    sfx_duck_db=2.0,
    sfx_bus_db=0.0,
    voice_bus_db=5.0,
    fade=(44.6, 45.9),
    sfx_level={"ransom_slap": -8, "label_blip": -2, "whoosh_up": -6, "cut_swish": -1, "panel_slam": -4, "live_on": -5,
               "paste_tick": -6, "send_whoosh": -6, "chat_pop": -6, "card_throw": -3, "plop_land": -4, "danmaku_tick": 0,
               "throw_whoosh": -3, "splat": -4, "poop_boing": -6, "voice_on": -7, "control_on": -6, "request_chime": -5,
               "cutin_whoosh": -5, "tension_riser": -9, "handover_zap": -6, "impact_big": -4, "vs_impact": -1, "name_slam": -5,
               "crowd_cheer": -8, "card_flip": -4, "sparkle": -8, "title_slam": -3, "whoosh_short": -6},
    hit_tracks=("kick", "brass", "snare", "timp"),
    process=process,
    chords=score.CHORDS,
    voice_engine="animalese",    # language-neutral voices: one track for zh + en subtitles
    film_id="G",
    ceiling_dbtp=-2.6,           # headroom so the AAC/Opus web encodes stay <= -1.5 dBTP without losing loudness
)

if __name__ == "__main__":
    info = build(ROOT / "films" / "G" / "cues.json", ROOT / "out" / "G" / "audio", score.compose, MIX)
    print(f"done in {info['render_s']:.1f}s  LUFS {info['lufs']:.2f}  TP {info['true_peak_dbtp']:.2f} dBTP")
    if "--no-web" not in sys.argv:
        r = subprocess.run([sys.executable, str(ROOT / "audio" / "web_export.py"), "G"], capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip())
