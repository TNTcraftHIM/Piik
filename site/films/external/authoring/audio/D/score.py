"""Film D score — 一起看，咔哒一下 · CLICK, AND WATCH TOGETHER (real UI). Bright bossa-funk, 120 BPM, F major.

120 BPM is the UI demo's own 0.5 s grid, so every real UI click lands on a beat or an 8th and the click SFX are part
of the groove. Cross-stick bossa clave, light kick, shaker, round bass with walking pickups, FM electric piano
comping, a marimba hook (kept under the tonal UI pops, which mostly sit at E5 and above), guitar chops when the friends
arrive, and a little whistle tune for the feature tiles. In the chorus the pong hits (SFX) ARE the melody, so the
music only plays offbeat stabs around them.
"""
from __future__ import annotations

import math

import numpy as np

from engine.core import SR, mtof
from engine import dsp, inst
from engine import inst_bc as ib
from engine.arrange import Arranger

CHORDS = {1: "Fmaj9", 2: "Fmaj9", 3: "Fmaj7", 4: ("Am7", "D9"), 5: "Gm9", 6: "C13", 7: "Fmaj7", 8: ("Am7", "D9"),
          9: "Gm9", 10: "C13", 11: "Bbmaj9", 12: "Am7", 13: "Gm9", 14: "Gm9", 15: "C13sus", 16: "Fmaj9", 17: "Dm9",
          18: "Gm9", 19: "C13", 20: "Bbmaj9", 21: "Am7", 22: "Gm9", 23: "C13", 24: "Fmaj9", 25: "Fmaj9", 26: "Fmaj9"}
# rootless EP voicings (mid register) and bass roots/fifths
EPV = {"Fmaj9": [57, 60, 64, 67], "Fmaj7": [53, 57, 60, 64], "Am7": [55, 60, 64, 69], "D9": [54, 60, 64, 69],
       "Gm9": [58, 62, 65, 69], "C13": [58, 62, 64, 69], "C13sus": [58, 62, 65, 69], "Bbmaj9": [57, 60, 62, 65],
       "Dm9": [53, 57, 60, 64]}
ROOT = {"Fmaj9": 41, "Fmaj7": 41, "Am7": 45, "D9": 38, "Gm9": 43, "C13": 36, "C13sus": 36, "Bbmaj9": 46, "Dm9": 38}
FIFTH = {"Fmaj9": 48, "Fmaj7": 48, "Am7": 52, "D9": 45, "Gm9": 50, "C13": 43, "C13sus": 43, "Bbmaj9": 41, "Dm9": 45}

# marimba hook, bars 3-10: (bar, step, note, len_steps). Lives under the UI pops (E5+), answers the clicks.
HOOK = [
    (3, 0, 72, 2), (3, 3, 69, 1), (3, 6, 72, 2), (3, 8, 74, 1), (3, 10, 76, 4),
    (4, 0, 76, 2), (4, 3, 74, 1), (4, 6, 72, 2), (4, 8, 69, 2), (4, 11, 72, 1), (4, 12, 69, 2), (4, 14, 66, 2),
    (5, 0, 67, 2), (5, 3, 70, 1), (5, 6, 74, 2), (5, 8, 76, 1), (5, 10, 77, 4),
    (6, 0, 74, 2), (6, 3, 72, 1), (6, 6, 70, 2), (6, 8, 69, 2), (6, 11, 67, 1), (6, 12, 64, 2), (6, 14, 67, 2),
    (7, 0, 72, 2), (7, 3, 69, 1), (7, 6, 72, 2), (7, 8, 74, 1), (7, 10, 77, 4),
    (8, 8, 74, 1), (8, 10, 72, 2), (8, 12, 69, 2), (8, 14, 66, 2),
    (9, 0, 67, 2), (9, 3, 70, 1), (9, 6, 74, 2), (9, 8, 79, 2), (9, 11, 77, 1), (9, 12, 74, 2), (9, 14, 77, 2),
    (10, 0, 76, 1), (10, 2, 74, 1), (10, 4, 72, 1), (10, 6, 70, 1), (10, 8, 69, 2), (10, 10, 67, 2), (10, 12, 72, 3),
]
# whistle tune over the feature tiles, [20,4] -> [24,1]: (bar, step, note, len_steps)
WHISTLE = [
    (20, 12, 77, 2), (20, 14, 79, 2),
    (21, 0, 81, 3), (21, 3, 79, 1), (21, 4, 76, 4), (21, 10, 72, 2), (21, 12, 74, 2), (21, 14, 76, 2),
    (22, 0, 77, 3), (22, 3, 76, 1), (22, 4, 74, 4), (22, 10, 70, 2), (22, 12, 72, 2), (22, 14, 74, 2),
    (23, 0, 76, 6), (23, 6, 79, 2), (23, 8, 81, 4), (23, 12, 79, 2), (23, 14, 76, 2),
    (24, 0, 77, 10),
]
# bossa comp rhythm (2-bar cycle): (step, len_steps, vel)
# control chapter: the EP climbs by inversions, Gm9 -> Gm9 -> C13sus
RISE = {13: [58, 62, 65, 69], 14: [62, 65, 69, 70], 15: [65, 69, 70, 74]}
COMP_A = [(0, 2.0, 0.55), (3, 1.5, 0.42), (6, 1.5, 0.45), (10, 2.0, 0.42), (12, 3.0, 0.5)]
COMP_B = [(2, 1.5, 0.45), (5, 1.5, 0.4), (8, 2.0, 0.5), (11, 1.5, 0.4), (14, 1.8, 0.45)]
CLAVE3 = "X.....X.....X..."   # bossa clave, 3-side
CLAVE2 = "....X.....X....."   # 2-side


def chord_at(bar, step=0.0):
    c = CHORDS.get(bar, "Fmaj9")
    if isinstance(c, tuple):
        return c[0] if step < 8 else c[1]
    return c


def whistle(events, vib_rate=5.4, vib_cents=22.0, rel=0.09, seed=0):
    """Soft whistled melody: sine with delayed vibrato, a touch of 2nd harmonic and breath; legato glides."""
    rng = np.random.default_rng(seed)
    n, freq, gate, velc, onsets = inst._line_curves(events, rel, legato_gap=0.02, glide_t=0.05)
    t = np.arange(n) / SR
    since = np.full(n, 10.0)
    for i0, _v in onsets:
        since[i0:] = np.minimum(since[i0:], t[i0:] - t[i0])
    depth = np.clip((since - 0.12) / 0.25, 0.0, 1.0) * vib_cents
    f = freq * 2.0 ** (depth * np.sin(2 * math.pi * vib_rate * t) / 1200.0)
    ph = 2 * math.pi * np.cumsum(f) / SR
    y = np.sin(ph) + 0.06 * np.sin(2 * ph)
    breath = dsp.svf(rng.uniform(-1, 1, n), f * 1.0, 6.0, "bpn") * 0.05
    a = 1.0 - math.exp(-1.0 / (0.025 * SR))
    r = 1.0 - math.exp(-1.0 / (rel / 4 * SR))
    env = inst._follow(gate, a, r)
    return (y + breath) * env * (0.6 + 0.4 * velc)


class Score:
    def __init__(self, a: Arranger):
        self.a = a
        self.g = a.g
        self.seed = 700

    def _s(self):
        self.seed += 1
        return self.seed

    def steps(self, k):
        return self.g.steps(k)

    # ------------------------------------------------------------------------------------------ instruments
    def ep(self, bar, step, sym, length, vel=0.5, up=0, roll=0.0, top=0, human=4.0):
        t = self.a.st(bar, step, human)
        notes = EPV[sym] + ([EPV[sym][-1] + 12] if top else [])
        for k, n in enumerate(notes):
            self.a.put("ep", inst.ep(n + up, self.steps(length), vel * (0.9 if k else 1.0), release=0.28, seed=self._s()),
                       t + roll * k)

    def comp(self, bar, pattern, vel=1.0, up=0, skip=()):
        for step, ln, v in pattern:
            if step in skip:
                continue
            self.ep(bar, step, chord_at(bar, step), ln, v * vel, up=up)

    def bass(self, bar, step, note, length, vel=0.8, slap=0.0, glide_from=None):
        self.a.put("bass", inst.bass(note, self.steps(length) * 0.9, vel, slap=slap, glide_from=glide_from,
                                     release=0.05, seed=self._s()), self.a.st(bar, step, 3.0))

    def ghost(self, bar, step, note, vel=0.35):
        self.a.put("bass", inst.bass_ghost(note, vel, seed=self._s()), self.a.st(bar, step, 3.0))

    def bossa_bass(self, bar, vel=0.8, nxt=None, walk=True):
        """Root (dotted quarter) - fifth - root - chromatic pickup into the next bar's root."""
        s0, s1 = chord_at(bar, 0), chord_at(bar, 8)
        self.bass(bar, 0, ROOT[s0], 5.5, vel)
        self.bass(bar, 6, FIFTH[s0] if s0 == s1 else ROOT[s0] + 12, 1.6, vel * 0.8)
        self.bass(bar, 8, ROOT[s1], 5.5 if walk else 7.5, vel * 0.92)
        if walk:
            target = ROOT[chord_at(nxt, 0)] if nxt else ROOT[s1]
            app = target - 1 if target - 1 != ROOT[s1] else target + 1
            self.bass(bar, 14, app, 1.6, vel * 0.75)

    def mar(self, bar, step, note, vel=0.62, glock=0.0, track="marimba"):
        t = self.a.st(bar, step, 3.0)
        self.a.put(track, inst.marimba(note, vel, dur=0.5), t)
        if glock:
            self.a.put("glock", inst.glock(note + 12, vel * glock, dur=0.7, seed=self._s()), t)

    def chop(self, bar, step, vel=0.45):
        sym = chord_at(bar, step)
        notes = [n + 12 for n in EPV[sym][1:]]
        self.a.put("gtr", inst.guitar_chop(notes, dur=0.065, vel=vel, wah=0.55, seed=self._s()), self.a.st(bar, step, 2.0))

    def stab(self, bar, step, sym=None, length=1.5, vel=0.6, up=12):
        sym = sym or chord_at(bar, step)
        notes = [n + up for n in EPV[sym]]
        self.a.put("stab", ib.house_stab(notes, self.steps(length), vel, bright=0.8, release=0.08, seed=self._s()),
                   self.a.st(bar, step, 2.0))

    def pad(self, bar, sym, bars=1.0, vel=0.32, up=0, attack=0.5, release=1.0):
        notes = [n + up for n in EPV[sym]]
        self.a.put("pad", ib.soft_pad(notes, self.g.bar * bars, vel, attack=attack, release=release, seed=self._s()),
                   self.g.t(bar))

    def crash(self, t, vel=0.5):
        self.a.hit("cym", "crash", t, vel, variants=3)

    # ------------------------------------------------------------------------------------------------ drums
    def kit(self, bar, kick="X.....x.X.......", rim=True, shaker=0.7, hats=None, clap=None, vel=1.0, ohat=False):
        a = self.a
        if kick:
            a.drum("kick", bar, kick, kind="kick_tight", vel=0.85 * vel)
        if rim:
            a.drum("rim", bar, CLAVE3 if bar % 2 == 1 else CLAVE2, vel=0.75 * vel, human_ms=2.0)
        if shaker:
            a.drum("shaker", bar, "xoxgxoxgxoxgxoxo", vel=shaker * vel, human_ms=2.5, pan=0.28)
        if hats:
            a.drum("hat", bar, hats, vel=0.6 * vel, human_ms=1.5, pan=-0.18)
        if ohat:
            a.drum("ohat", bar, "..............x.", vel=0.45 * vel, pan=-0.18)
        if clap:
            a.drum("clap", bar, clap, vel=0.75 * vel)


def compose(a: Arranger) -> dict:
    sc = Score(a)
    g = a.g
    T = g.t

    # ---- bars 1-2: intro — the card lands into a soft Fmaj9 bloom; the title pops are part of the tune --------------
    sc.ep(1, 0, "Fmaj9", 15, vel=0.5, roll=0.03, top=1)
    sc.pad(1, "Fmaj9", bars=1.9, vel=0.3, attack=0.35)
    sc.bass(1, 0, 41, 15, vel=0.55)
    a.put("glock", inst.glock(84, 0.32, dur=1.0, seed=sc._s()), T(1, 3))
    a.drum("shaker", 1, "........xoxgxoxo", vel=0.45, human_ms=2.5, pan=0.28)
    sc.kit(2, kick=None, rim=False, shaker=0.55)
    a.drum("rim", 2, "............x.xx", vel=0.6)
    sc.bass(2, 0, 41, 5.5, 0.7)
    sc.bass(2, 6, 48, 1.6, 0.6)
    sc.bass(2, 8, 41, 5.5, 0.68)
    sc.bass(2, 14, 40, 1.6, 0.6)
    sc.ep(2, 3, "Fmaj9", 2, 0.42)
    sc.ep(2, 6, "Fmaj9", 1.5, 0.38)
    for step, note in ((8, 72), (10, 69), (11, 72), (12, 74), (14, 76)):
        sc.mar(2, step, note, 0.55)

    # ---- bars 3-6: go live — groove A in on the first big click --------------------------------------------------
    sc.crash(T(3, 1), 0.42)
    for bar in range(3, 7):
        sc.kit(bar, kick="X.....x.X......." if bar % 2 else "X.....x.X.....x.")
        sc.bossa_bass(bar, 0.8, nxt=bar + 1)
        sc.comp(bar, COMP_A if bar % 2 else COMP_B, 0.85)
    # 'You're live!' [3,4] -> [4,1]: a little lift
    a.hit("kick", "kick_tight", T(4, 1), 0.7)

    # ---- bars 7-10: friends join — groove A+ (hats, guitar chops); danmaku bar 9, tomato/poop bar 10 ------------
    for bar in range(7, 11):
        sc.kit(bar, kick="X.....x.X.....x.", hats="o.x.o.x.o.x.o.x.", ohat=bar % 2 == 0)
        sc.bossa_bass(bar, 0.82, nxt=bar + 1)
        sc.comp(bar, COMP_A if bar % 2 else COMP_B, 0.85)
        for step in (2, 6, 10, 14):
            sc.chop(bar, step, 0.42 if step % 4 == 2 else 0.36)
    sc.crash(T(7, 1), 0.38)
    for bar, step, note, ln in HOOK:
        sc.mar(bar, step, note, 0.54 if ln >= 2 else 0.45, glock=0.12 if bar >= 7 else 0.0)
    # bar 10 tag: a tiny marimba tumble after the poop boing
    for k, note in enumerate((84, 81, 79, 76)):
        a.put("glock", inst.glock(note, 0.18, dur=0.5, seed=sc._s()), a.st(10, 14) + k * g.steps(0.5))

    # ---- bars 11-12: voice — lighter: no kick, pad + rim, long bass; room for two short lines --------------------
    for bar, sym in ((11, "Bbmaj9"), (12, "Am7")):
        sc.pad(bar, sym, bars=1.0, vel=0.3, attack=0.25, release=0.6)
        sc.kit(bar, kick=None, shaker=0.5, vel=0.85)
        sc.bass(bar, 0, ROOT[sym], 7.5, 0.62)
        sc.bass(bar, 8, FIFTH[sym] if sym != "Bbmaj9" else 46, 5.5, 0.55)
    sc.bass(12, 14, 44, 1.6, 0.5)                     # Ab: chromatic step down into Gm9
    sc.ep(11, 0, "Bbmaj9", 3, 0.42)
    sc.ep(11, 6, "Bbmaj9", 2, 0.36)
    sc.ep(12, 4, "Am7", 2, 0.38)
    sc.ep(12, 8, "Am7", 3, 0.34)

    # ---- bars 13-15: remote control — tension: bass pedal, ticking hats, rising EP; build from [15,3] -----------
    for bar in (13, 14, 15):
        sym = chord_at(bar)
        root = ROOT[sym]
        sc.a.drum("kick", bar, "X.......X......." if bar < 15 else "X.......X.x.x.x.", kind="kick_tight", vel=0.62)
        a.drum("hat", bar, "xoxoxoxoxoxoxoxo", vel=0.38 + 0.08 * (bar - 13), human_ms=1.0, pan=-0.2)
        a.drum("rim", bar, CLAVE3 if bar % 2 else CLAVE2, vel=0.55)
        a.drum("shaker", bar, "x.x.x.x.x.x.x.x.", vel=0.4, pan=0.28)
        for step in range(0, 16, 2):
            if bar == 15 and step >= 14:
                continue
            sc.bass(bar, step, root, 1.4, 0.55 + 0.1 * (step % 4 == 0) + 0.05 * (bar - 13))
        k = bar - 13
        for step in (0, 8):
            t = a.st(bar, step, 4.0)
            for j, n in enumerate(RISE[bar]):
                a.put("ep", inst.ep(n, g.steps(5), (0.38 if step == 0 else 0.34) + 0.04 * k, release=0.28, seed=sc._s()), t)
        sc.pad(bar, sym, bars=1.0, vel=0.18 + 0.04 * (bar - 13), up=12, attack=0.6, release=0.3)
    for bar in (13, 14):
        for step, note in ((0, 74), (2, 69), (4, 70), (6, 69), (8, 74), (10, 69), (12, 77), (14, 69)):
            sc.mar(bar, step, note, 0.3 if step % 4 else 0.38)
    for k in range(6):                                 # snare roll from [15,3] (Allow control) to the breath
        a.hit("snare", "snare_ghost" if k < 3 else "snare", a.st(15, 8 + k), 0.3 + 0.1 * k)
    for k, note in enumerate((36, 38, 40)):            # walk-up C-D-E into the drop's F
        sc.bass(15, 8 + 2 * k, note, 1.6, 0.7 + 0.05 * k)
    sc.bass(15, 14, 40, 1.8, 0.75, glide_from=36)      # (the 16th before the drop stays dry for the breath)

    # ---- bars 16-19: let's play — chorus; the pong hits (SFX) are the melody, music plays around them ---------------
    sc.crash(T(16, 1), 0.7)
    for bar in range(16, 20):
        sym = chord_at(bar)
        root, fifth = ROOT[sym], FIFTH[sym]
        four = bar >= 18
        sc.kit(bar, kick="X...X...X...X..." if four else "X.....x.X.....x.", hats="..x...x...x...x.", clap="....X.......X...",
               shaker=0.75, ohat=True, vel=1.12)
        sc.pad(bar, sym, bars=1.0, vel=0.2, up=12, attack=0.08, release=0.3)
        # funky octave bass
        for step, note, ln, v in ((0, root, 2.5, 0.9), (3, root, 0.8, 0.5), (6, root + 12, 1.2, 0.7), (8, root, 2.5, 0.85),
                                  (10, fifth, 1.2, 0.65), (12, root + 12, 1.2, 0.7)):
            sc.bass(bar, step, note, ln, v, slap=0.25 if note > root else 0.0)
        sc.ghost(bar, 5, root, 0.3)
        nxt = ROOT[chord_at(bar + 1)]
        sc.bass(bar, 14, nxt - 1 if nxt - 1 != root else nxt + 1, 1.5, 0.7)
        # offbeat EP skank + a bright stab on the 'and' of 4
        for step in (2, 6, 10):
            sc.ep(bar, step, sym, 1.0, 0.42, up=0)
        sc.stab(bar, 14, sym, 1.2, 0.5)
    sc.crash(T(18, 1), 0.38)                          # four-on-the-floor from here: the rally speeds up
    for k, note in enumerate((72, 74, 76, 79)):        # marimba fill between [17,3] and [18,1]
        sc.mar(17, 12 + k, note, 0.42)
    # smash [19,4]: everything hits with P2's winning return
    t = T(19, 4)
    a.hit("kick", "kick", t, 1.0)
    a.hit("clap", "clap", t, 0.9)
    sc.stab(19, 12, "C13", 1.6, 0.75)
    sc.crash(t, 0.55)

    # ---- bars 20-23: features — point jingle, then a cheerful groove; stabs under the six tile flips -------------
    t = T(20, 1)
    sc.crash(t, 0.6)
    a.hit("kick", "kick", t, 0.9)
    flips = {(20, 8), (21, 0), (21, 8), (22, 0), (22, 8), (23, 0)}
    for bar in range(20, 24):
        sym = chord_at(bar)
        sc.kit(bar, kick="X.....x.X......." if bar > 20 else "......x.X.......", hats="o.x.o.x.o.x.o.x.",
               clap="............X...", shaker=0.7, ohat=bar % 2 == 1)
        sc.bossa_bass(bar, 0.8, nxt=bar + 1)
        sc.comp(bar, COMP_B if bar % 2 == 0 else COMP_A, 0.75, skip=(0, 8))
        for step in (0, 8):
            if (bar, step) in flips:
                sc.stab(bar, step, sym, 1.6, 0.55)
                a.put("glock", inst.glock(EPV[sym][-1] + 24, 0.16, dur=0.6, seed=sc._s()), a.st(bar, step))
    sc.pad(20, "Bbmaj9", bars=1.0, vel=0.2, up=12, attack=0.2, release=0.5)
    phrase0 = a.st(20, 12)
    ev = [(a.st(bar, step) - phrase0, g.steps(ln) * 0.95, note, 0.8) for bar, step, note, ln in WHISTLE]
    a.put("whistle", whistle(ev, seed=sc._s()), phrase0)

    # ---- bars 24-26: end card — resolve on Fmaj9, room for the sonic logo at [25,1], ring out --------------------
    t = T(24, 1)
    sc.crash(t, 0.45)
    a.hit("kick", "kick", t, 0.85)
    sc.ep(24, 0, "Fmaj9", 14, 0.5, roll=0.02, top=1)
    sc.pad(24, "Fmaj9", bars=2.6, vel=0.3, attack=0.2, release=1.6)
    sc.bass(24, 0, 41, 7.5, 0.8)
    sc.bass(24, 8, 48, 3.5, 0.6)
    sc.bass(24, 12, 41, 3.5, 0.62)
    for k, note in enumerate((65, 69, 72, 76, 79, 81)):
        sc.mar(24, k, note, 0.5 + 0.03 * k, glock=0.15)
    sc.kit(24, kick=None, shaker=0.55, vel=0.8)
    # [25,1] piik_chirp gets the bar to itself; the final chord blooms under the URL at [25,3]
    sc.bass(25, 8, 41, 14, 0.6)
    sc.ep(25, 8, "Fmaj9", 14, 0.42, up=12, roll=0.04)
    a.put("glock", inst.glock(89, 0.25, dur=1.6, seed=sc._s()), T(25, 3) + 0.12)
    a.drum("shaker", 25, "........xoxgxoxo", vel=0.4, pan=0.28)
    return {}
