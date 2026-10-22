"""Build Film E's soundtrack (打倒无聊 · DEFEAT BOREDOM) from films/E/cues.json.

    Piik-PV/.venv/Scripts/python.exe Piik-PV/audio/E/build.py

The message boxes in the cue sheet are expanded into language-neutral text blips (one every 32nd note while a box
is typing, pitched per speaker), so the same soundtrack serves the zh and en cuts. Writes out/E/audio/
{music,sfx,voice,mix}.wav (48 kHz / 24-bit / exactly 58.000 s), report/plots, and web.webm (Opus) + web.m4a (AAC).
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]  # Piik-PV
sys.path.insert(0, str(ROOT / "audio"))
sys.path.insert(0, str(HERE))

from engine import fx  # noqa: E402
from engine.film import FilmMix, build, default_process  # noqa: E402
import sfx_e  # noqa: E402,F401  (registers the e_* sounds)
import score  # noqa: E402

CUES = ROOT / "films" / "E" / "cues.json"
OUT = ROOT / "out" / "E" / "audio"


def expand_blips(cues: dict) -> dict:
    spb = 60.0 / cues["bpm"]
    bpb = cues.get("beatsPerBar", 4)

    def pos(t):
        beats = t / spb
        bar = int(beats // bpb) + 1
        return [bar, round(beats - (bar - 1) * bpb + 1, 6)]

    sfx = list(cues["sfx"])
    step = spb / 8.0  # 32nd notes
    for i, b in enumerate(cues.get("boxes", [])):
        t0 = ((b["at"][0] - 1) * bpb + (b["at"][1] - 1)) * spb
        n = max(2, int(math.floor(b["type"] * spb / step)))
        duty, base, spread, ln, wob = sfx_e.VOICES[b["who"]]
        for k in range(n):
            if b["who"] != "boss" and k % 4 == 3:
                continue  # tiny gaps make it read as syllables
            note = base + spread[(k * 3 + i * 5 + (k // 4)) % len(spread)]
            sfx.append({"at": pos(t0 + k * step), "name": f"e_blip_{b['who']}", "note": note})
    out = dict(cues)
    out["sfx"] = sorted(sfx, key=lambda e: (e["at"][0], e["at"][1]))
    return out


def process(name, x):
    if name in ("p1", "p2"):
        return fx.lp(fx.hp(x, 140.0), 10000.0)
    if name == "tri":
        return fx.hp(x, 28.0)
    if name == "crash":
        return fx.lp(fx.hp(x, 400.0), 12000.0)
    if name == "tom":
        return fx.hp(x, 45.0)
    return default_process(name, x)


MIX = FilmMix(
    title="Film E — 打倒无聊 · DEFEAT BOREDOM",
    length=58.0,
    swing=0.5,
    gains={"p1": -3.0, "p2": -5.0, "tri": -9.0, "kick": -3.5, "snare": -7.5, "hat": -11.0, "crash": -13.0, "tom": -7.0},
    send_room={"snare": -14.0, "kick": -20.0, "tom": -14.0},
    send_plate={"p1": -20.0, "p2": -18.0},
    send_delay={"p1": -18.0},
    delay_beats=0.75,
    sidechain={},
    line_duck_db=0.0,
    sfx_duck_db=2.5,
    sfx_bus_db=0.0,
    fade=(57.0, 57.95),
    ceiling_dbtp=-2.6,
    hit_tracks=("kick", "p1", "p2", "tri", "snare", "crash"),
    process=process,
    chords=score.CHORDS,
)


def encode_web(out_dir: Path):
    mix = out_dir / "mix.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mix), "-c:a", "libopus", "-b:a", "112k", "-vbr", "on", str(out_dir / "web.webm")], check=True)
    # AAC overshoots square-wave chip audio by ~1.4 dB; trim 0.6 dB so the encode stays under -1.5 dBTP
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mix), "-af", "volume=-0.6dB", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out_dir / "web.m4a")], check=True)
    res = {}
    for f in ("web.webm", "web.m4a"):
        r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(out_dir / f), "-af", "ebur128=peak=true", "-f", "null", "-"],
                           capture_output=True, text=True)
        tail = r.stderr[r.stderr.rfind("Summary:"):]
        lufs = float(tail.split("I:")[1].split("LUFS")[0])
        peak = float(tail.split("Peak:")[1].split("dBFS")[0])
        res[f] = (lufs, peak)
    return res


if __name__ == "__main__":
    cues = expand_blips(json.loads(CUES.read_text(encoding="utf-8")))
    OUT.mkdir(parents=True, exist_ok=True)
    exp_path = OUT / "cues_expanded.json"
    exp_path.write_text(json.dumps(cues, ensure_ascii=False, indent=1), encoding="utf-8")
    info = build(exp_path, OUT, score.compose, MIX)
    print(f"done in {info['render_s']:.1f}s  LUFS {info['lufs']:.2f}  TP {info['true_peak_dbtp']:.2f} dBTP")
    for f, (l, p) in encode_web(OUT).items():
        print(f"  {f}: {l:.1f} LUFS, true peak {p:.1f} dBTP")
