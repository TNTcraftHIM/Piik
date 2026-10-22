"""Build Film A's soundtrack (预告状 · THE CALLING CARD) from films/A/cues.json.

    Piik-PV/.venv/Scripts/python.exe Piik-PV/audio/A/build.py

Writes out/A/audio/{music,sfx,voice,mix}.wav (48 kHz / 24-bit / stereo / exactly 64.000 s) plus QA artifacts
(spectrogram.png, rms.png, report.txt). Deterministic: same inputs -> bit-identical outputs.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]  # Piik-PV
sys.path.insert(0, str(ROOT / "audio"))
sys.path.insert(0, str(HERE))

from engine.film import FilmMix, build  # noqa: E402
import score  # noqa: E402

MIX = FilmMix(
    title="Film A — 预告状 · THE CALLING CARD",
    length=64.0,
    swing=0.54,
    # track gains (dB), tuned against the per-track RMS table and band balance in report.txt
    gains={"kick": -6.0, "snare": -2.5, "clap": -9.0, "hat": -8.0, "ohat": -12.0, "shaker": -14.0, "rim": -9.0,
           "tom": -8.5, "cym": -12.0, "timp": -6.5, "bass": -4.0, "bass_slide": -4.0, "ep": -8.0, "gtr": -1.0,
           "brass": -5.0, "strings": -7.0, "lead": -6.5, "glock": -14.0, "trombone": -8.0, "perc_x": -13.0},
    send_room={"snare": -12.0, "clap": -10.0, "tom": -14.0, "rim": -14.0},
    send_plate={"ep": -15.0, "brass": -12.0, "lead": -13.0, "strings": -11.0, "glock": -7.0, "gtr": -17.0,
                "trombone": -12.0, "timp": -18.0},
    send_delay={"lead": -13.0},
    delay_beats=0.75,
    sidechain={"bass": 3.0, "ep": 1.5, "strings": 3.0, "gtr": 1.5},
    line_duck_db=4.0,
    line_duck_extra={"whiny": 3.0},
    voice_gain={"laugh": -2.0, "whiny": 1.5},
    sfx_duck_db=2.0,
    sfx_bus_db=0.5,
    voice_bus_db=5.0,
    tv_intro=([2, 4], [3, 1]),   # cold open heard through the TV, bursts open on the first panel slam
    no_tv={"bass_slide"},        # ...except the bass slide-in, which 'breaks out' of the set
    crackle_db=-6.0,
    fade=(61.9, 63.95),
    chords=score.CHORDS,
    voice_engine="animalese",    # language-neutral voices: one track for zh + en subtitles
    film_id="A",
    ceiling_dbtp=-2.2,           # headroom so AAC/Opus web encodes stay <= -1.5 dBTP without losing loudness
)

if __name__ == "__main__":
    info = build(ROOT / "films" / "A" / "cues.json", ROOT / "out" / "A" / "audio", score.compose, MIX)
    print(f"done in {info['render_s']:.1f}s  LUFS {info['lufs']:.2f}  TP {info['true_peak_dbtp']:.2f} dBTP")
