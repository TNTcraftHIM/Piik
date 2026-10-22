"""Film C score — 沙发够长 · PLENTY OF ROOM (9:16 social cut). Kawaii future bass, 150 BPM half-time, C major.

The 19 'pop_friend' landings (SFX) are the hook of the build, so the music there stays low and supportive: pumping
supersaw swells whose filter opens bar by bar under the pops. The drop is two chords per bar struck on every
beat (lined up with the emoji fireworks) with a vocal-chop hook doubled by plucks and a music box.
"""
from __future__ import annotations

import numpy as np

from engine.core import SR, nn
from engine import dsp, voice
from engine import inst_bc as ib
from engine.arrange import Arranger

SV = {  # supersaw voicings (wide, bright)
    "Fmaj7": ["F3", "C4", "E4", "A4"], "G6": ["G3", "D4", "E4", "B4"], "Am7": ["A3", "E4", "G4", "C5"],
    "C": ["C4", "G4", "C5", "E5"], "G": ["G3", "D4", "G4", "B4"], "Fmaj9": ["F3", "C4", "E4", "G4", "A4"],
    "Em7": ["E3", "B3", "D4", "G4"], "Cmaj9": ["C3", "G3", "D4", "E4", "B4"],
}
ROOT808 = {"Fmaj7": "F1", "G6": "G1", "Am7": "A1", "C": "C2", "G": "G1", "Fmaj9": "F1", "Em7": "E1", "Cmaj9": "C2"}
CHORDS = {1: "Fmaj7", 2: "G6", 3: "Am7", 4: "Fmaj7", 5: "C", 6: "G", 7: ("Fmaj9", "G"), 8: ("Em7", "Am7"),
          9: "Fmaj9", 10: "G6", 11: "Cmaj9", 12: "Cmaj9"}
# music-box intro phrase (bar, step, note)
MB_INTRO = [(1, 0, "E6"), (1, 3, "C6"), (1, 6, "A5"), (1, 10, "G5"), (1, 14, "A5"),
            (2, 0, "B5"), (2, 3, "G5"), (2, 6, "E5"), (2, 10, "D5"), (2, 13, "G5")]
# drop hook: (bar, step, len_steps, note, vowel) — chops sing it, plucks/music box double an octave up
HOOK = [(7, 0, 2, "A4", "a"), (7, 2, 2, "C5", "i"), (7, 4, 3, "E5", "a"), (7, 7, 1, "D5", "o"),
        (7, 8, 2, "B4", "a"), (7, 10, 2, "D5", "i"), (7, 12, 3, "G5", "ai"), (7, 15, 1, "E5", "o"),
        (8, 0, 2, "G5", "a"), (8, 2, 2, "E5", "i"), (8, 4, 3, "D5", "a"), (8, 7, 1, "C5", "o"),
        (8, 8, 2, "E5", "a"), (8, 10, 2, "C5", "i"), (8, 12, 4, "A4", "ao")]


def chord_at(bar, beat=1.0):
    c = CHORDS.get(bar)
    if isinstance(c, tuple):
        return c[0] if beat < 3 else c[1]
    return c


def N(names):
    return [nn(x) for x in names]


class Score:
    def __init__(self, a: Arranger):
        self.a = a
        self.g = a.g
        self.seed = 300

    def _s(self):
        self.seed += 1
        return self.seed

    def saw(self, t, sym, dur, vel=0.7, bend=0.0, swell=0.0, release=0.2, cutoff=6500.0, up=0, track="saw"):
        ns = [n + up for n in N(SV[sym])]
        self.a.put(track, ib.supersaw(ns, dur, vel, bend_from=bend, swell=swell, release=release, cutoff=cutoff,
                                      seed=self._s()), t)

    def b808(self, t, sym, dur, vel=0.9, glide_from=None, track="bass808"):
        self.a.put(track, ib.sub808(nn(ROOT808[sym]), dur, vel, glide_from=glide_from), t)

    def halftime(self, bar, vel=1.0, kick="X.........X.....", hats="x.x.x.x.x.x.x.x.", shaker=True, clap=True):
        a = self.a
        a.drum("kick", bar, kick, vel=vel)
        if clap:
            a.drum("snare", bar, "........X.......", vel=0.85 * vel)
            a.drum("clap", bar, "........X.......", vel=0.9 * vel)
        a.drum("hat", bar, hats, vel=0.75 * vel, human_ms=1.5)
        if shaker:
            a.drum("shaker", bar, "gogogogogogogogo", vel=0.75 * vel, human_ms=2, pan=0.3)

    def pump(self, bars):
        for bar in bars:
            for beat in (1, 2, 3, 4):
                self.a.sc_extra.append(self.g.t(bar, beat))

    def crash(self, t, vel=0.7):
        self.a.hit("cym", "crash", t, vel, variants=3)


def compose(a: Arranger) -> dict:
    sc = Score(a)
    g = a.g
    T = g.t
    st = g.steps(1)  # one 16th = 0.1 s

    # ---- bars 1-2: lonely-but-cheeky intro: music box, soft pluck chords, light shaker -------------------------
    for bar, step, note in MB_INTRO:
        a.put("musicbox", ib.musicbox(nn(note), 0.55, seed=sc._s()), a.st(bar, step))
    for bar in (1, 2):
        sym = chord_at(bar)
        for step in (0, 6):
            for k, n in enumerate(N(SV[sym])):
                a.put("pluck", ib.saw_pluck(n, 0.2, 0.42 if step == 0 else 0.32, bright=0.5, seed=sc._s()),
                      a.st(bar, step) + 0.006 * k)
        a.drum("shaker", bar, "x.x.x.x.x.x.x.x.", vel=0.5, human_ms=2, pan=0.3)

    # ---- bars 3-6: build under the 19 pops — low, pumping, swelling; filter opens bar by bar ---------------------
    sc.pump(range(3, 7))
    sc.crash(T(3, 1), 0.65)
    for k, bar in enumerate((3, 4, 5, 6)):
        sym = chord_at(bar)
        sc.saw(T(bar, 1), sym, g.bar * 0.97, vel=0.32 + 0.05 * k, swell=0.35, release=0.12,
               cutoff=1500.0 + 1400.0 * k)
        sc.b808(T(bar, 1), sym, g.bar * 0.9, 0.7 + 0.05 * k, track="bass808b")   # build: its own, lower bus
        if bar < 6:
            sc.halftime(bar, vel=0.72 + 0.06 * k, shaker=bar >= 4)
    a.drum("kick", 6, "X.......X.......")
    for k in range(8):                                  # 16th snare roll into the stamp
        a.hit("snare", "snare", a.st(6, k), 0.3 + 0.07 * k)
    t = T(6, 3)                                         # stamp hit
    a.hit("clap", "clap", t, 1.0)
    sc.saw(t, "G", 0.18, 0.75, release=0.08, cutoff=7000.0)
    for k in range(6):                                  # 32nds up to the breath at [6,4.5]
        a.hit("snare", "snare", t + st * 2 + k * st / 2, 0.55 + 0.08 * k)
    a.drum("hat", 6, "x.x.x.x.........", vel=0.7)

    # ---- bars 7-8: DROP — chords on every beat (fireworks), vocal-chop hook ------------------------------------------
    sc.pump(range(7, 9))
    sc.crash(T(7, 1), 0.9)
    for bar in (7, 8):
        sc.halftime(bar, vel=1.0, kick="X.....x...X.....", hats="x.x.x.x.x.x.xxxx")
        for beat in (1, 2, 3, 4):
            sym = chord_at(bar, beat)
            first = beat in (1, 3)
            sc.saw(T(bar, beat), sym, g.beat * 0.78, vel=1.0 if first else 0.85, bend=-1.0 if first else 0.0,
                   release=0.1, cutoff=9500.0, track="sawd")
            if first:  # sustained wide layer under the stabs (pumped by the sidechain)
                sc.saw(T(bar, beat), sym, g.beat * 1.9, vel=0.45, swell=0.04, release=0.08, cutoff=5000.0, up=12,
                       track="sawd")
            sc.saw(T(bar, beat) + g.beat / 2, sym, g.beat * 0.3, vel=0.42, release=0.06, cutoff=8000.0, track="sawd")
            if first:
                sc.b808(T(bar, beat), sym, g.beat * 1.9, 1.0)
        for beat in (2, 4):
            a.hit("kick", "kick", T(bar, beat), 0.55)   # light beat accents so every firework lands on a hit
    for bar, step, ln, note, vow in HOOK:
        tt = a.st(bar, step)
        d = ln * st * 0.92
        a.put("chop", voice.chop(nn(note), d, vow, who="dian", vel=0.85, glide=-1.5 if ln >= 2 else 0.0,
                                 seed=sc._s()), tt)
        a.put("pluck", ib.saw_pluck(nn(note) + 12, d, 0.5, seed=sc._s()), tt)
        a.put("musicbox", ib.musicbox(nn(note) + 12, 0.3, 0.6, seed=sc._s()), tt)

    # ---- bars 9-10: lighter groove, stabs on the four text slams; F->C flick into the end ----------------------------
    sc.pump(range(9, 11))
    for bar in (9, 10):
        sym = chord_at(bar)
        sc.halftime(bar, vel=0.85, shaker=False)
        sc.b808(T(bar, 1), sym, g.bar * 0.9, 0.85)
        sc.saw(T(bar, 1), sym, g.bar * 0.95, vel=0.32, swell=0.2, release=0.1, cutoff=3500.0)
        for beat in (1, 3):
            sc.saw(T(bar, beat), sym, 0.16, 0.8, release=0.06, cutoff=8000.0, up=12)
    for k, nt in enumerate(("F5", "A5", "C6", "E6")):
        a.put("musicbox", ib.musicbox(nn(nt), 0.45, 0.8, seed=sc._s()), T(10, 4) + k * st)

    # ---- bars 11-12: final Cmaj9 with the sonic logo, ring out -----------------------------------------------------------
    t = T(11, 1)
    sc.crash(t, 0.8)
    a.hit("kick", "kick", t, 1.0)
    sc.saw(t, "Cmaj9", g.bar * 1.0, vel=0.85, bend=-1.0, release=1.2, cutoff=7000.0)
    sc.b808(t, "Cmaj9", g.bar * 1.1, 0.95)
    for k, nt in enumerate(("C6", "E6", "G6", "B6", "D7")):
        a.put("musicbox", ib.musicbox(nn(nt), 0.42 - 0.05 * k, 1.4, seed=sc._s()), t + 0.3 + k * st)
    return {}
