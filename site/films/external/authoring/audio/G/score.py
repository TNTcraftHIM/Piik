"""Film G score — 作战会议 · MISSION BRIEFING. Phantom-thief heist acid-jazz, 120 BPM, D minor -> F major.

120 BPM is the UI demo's own 0.5 s grid, so every real UI click lands on a beat or an 8th. Bar-by-bar arrangement that
follows films/G/cues.json: a sneaky bass ostinato for the cold open, a swung funk groove (rim/snare ghosts, 16th hats,
walking/funk bass with chromatic approaches, EP comp, guitar chops) under the five missions with a brass stab on every
mission title, click and stamp, a tension bar with a true stop for Yuan's cut-in, a brass heist hook over the VS rally
(the tuned rally hits are SFX and sit on chord tones of the hook), stop-time band hits under the six dossier stamps
(ii-V-I into F major), and a bright F6/9 ending under the sonic logo.
"""
from __future__ import annotations

import numpy as np

from engine.core import nn
from engine import inst, drums, dsp
from engine.arrange import Arranger

CHORDS = {1: "Dm9", 2: "Dm9", 3: "Dm9", 4: "G13", 5: "Dm9", 6: "G13", 7: "Bbmaj9", 8: "A7#9", 9: "Dm9", 10: "G13",
          11: "Bbmaj9", 12: "Bbmaj9", 13: ("A7sus4", "A7b9"), 14: "Dm9", 15: "G13", 16: ("Bbmaj9", "A7#9"), 17: "A7#9",
          18: "Gm9", 19: "C13", 20: "Fmaj9", 21: "F6/9", 22: "F6/9", 23: "F6/9"}
# rootless mid-register voicings (MIDI) and bass roots
V = {"Dm9": [53, 57, 60, 64], "G13": [53, 59, 64, 69], "Bbmaj9": [57, 60, 62, 65], "A7#9": [61, 64, 67, 72],
     "A7sus4": [55, 62, 64, 69], "A7b9": [61, 64, 67, 70], "Gm9": [58, 62, 65, 69], "C13": [58, 62, 64, 69],
     "Fmaj9": [57, 60, 64, 67], "F6/9": [57, 62, 67, 72]}
ROOT = {"Dm9": 38, "G13": 31, "Bbmaj9": 34, "A7#9": 33, "A7sus4": 33, "A7b9": 33, "Gm9": 31, "C13": 36, "Fmaj9": 29,
        "F6/9": 29}
THIRD = {"Dm9": 3, "G13": 4, "Bbmaj9": 4, "A7#9": 4, "A7sus4": 5, "A7b9": 4, "Gm9": 3, "C13": 4, "Fmaj9": 4, "F6/9": 4}

# heist hook (brass, bars 14-17): (bar, step, len_steps, note)
HOOK = [(14, 0, 2, "D5"), (14, 3, 1, "F5"), (14, 4, 2, "G5"), (14, 6, 2, "A5"), (14, 10, 1, "G5"), (14, 11, 1, "F5"), (14, 12, 4, "D5"),
        (15, 0, 2, "E5"), (15, 3, 1, "F5"), (15, 4, 2, "G5"), (15, 6, 2, "B5"), (15, 10, 1, "A5"), (15, 11, 1, "G5"), (15, 12, 4, "E5"),
        (16, 0, 2, "F5"), (16, 2, 2, "G5"), (16, 4, 3, "A5"), (16, 7, 1, "Bb5"), (16, 8, 2, "C6"), (16, 10, 2, "Bb5"), (16, 12, 2, "A5"),
        (16, 14, 2, "C#6"), (17, 0, 6, "D6")]
# cold-open spy line (bass, bars 1-2): (bar, step, note, len_steps, vel)
SPY = [(1, 0, "D2", 1.5, 1.0), (1, 2, "D2", 1, 0.7), (1, 4, "F2", 1.5, 0.85), (1, 6, "D2", 1, 0.7), (1, 8, "G2", 1.5, 0.85),
       (1, 10, "G#2", 1.5, 0.85), (1, 12, "A2", 2, 0.95), (1, 14, "C3", 1, 0.8), (1, 15, "C#3", 1, 0.8),
       (2, 0, "D3", 1, 0.95), (2, 4, "A2", 1, 0.8), (2, 6, "G#2", 1, 0.75), (2, 8, "G2", 1.5, 0.85), (2, 10, "F2", 1.5, 0.8),
       (2, 12, "E2", 1, 0.85), (2, 13, "F2", 1, 0.8), (2, 14, "G#2", 1, 0.85), (2, 15, "A2", 1, 0.9)]


def under(note, sym):
    """Second brass voice: the nearest chord tone at least a minor third below the melody note."""
    pcs = {(n % 12) for n in V[sym]} | {ROOT[sym] % 12}
    n = note - 3
    while n % 12 not in pcs:
        n -= 1
    return n


def chord_at(bar, beat=1.0):
    c = CHORDS.get(bar, "Dm9")
    if isinstance(c, tuple):
        return c[0] if beat < 3 else c[1]
    return c


class Score:
    def __init__(self, a: Arranger):
        self.a = a
        self.g = a.g
        self.seed = 0

    def _s(self):
        self.seed += 1
        return self.seed

    # drums ------------------------------------------------------------------------------------------
    def groove(self, bar, variant=0, vel=1.0, ride=False):
        a = self.a
        a.drum("kick", bar, ["X.....x...X.....", "X.....x...X..x.."][variant % 2], vel=vel)
        a.drum("snare", bar, "....X.......X...", vel=0.92 * vel)
        a.drum("snare", bar, ".g.....g.g....g.", kind="snare_ghost", vel=0.8 * vel, human_ms=2)
        if ride:
            a.drum("ride", bar, "x.xxx.xxx.xxx.x.", vel=0.55 * vel, human_ms=2)
        else:
            a.drum("hat", bar, "xoxoxoxoxoxoxoxo", vel=0.7 * vel, human_ms=2.5, skip=(14,) if variant % 2 else ())
            if variant % 2:
                a.drum("ohat", bar, "..............x.", vel=0.5 * vel)
        a.drum("shaker", bar, "o.o.o.o.o.o.o.o.", vel=0.5 * vel, human_ms=3, pan=0.35)

    def crash(self, t, vel=1.0):
        self.a.hit("cym", "crash", t, vel, variants=3)

    # pitched ----------------------------------------------------------------------------------------
    def bass_note(self, t, note, dur, vel=1.0, slap=0.3):
        self.a.put("bass", inst.bass(note, dur, vel, slap=slap, seed=self._s()), t)

    def funk_bass(self, bar, vel=1.0, nxt=None):
        """One bar of funk bass on the bar's chord, walking chromatically into the next bar's root."""
        a, g = self.a, self.g
        sym = chord_at(bar)
        r, third = ROOT[sym], THIRD[sym]
        if r < 33:
            r += 12
        nr = ROOT[chord_at(nxt or bar + 1)]
        while nr < r - 6:
            nr += 12
        while nr > r + 6:
            nr -= 12
        line = [(0, r, 2, 1.0, "n"), (3, r + 12, 1, 0.88, "p"), (4, r, 1, 0.4, "x"), (6, r + 10, 1, 0.7, "n"),
                (7, r + 12, 1, 0.82, "n"), (8, r + 7, 2, 0.9, "n"), (10, r, 1, 0.78, "n"), (11, r, 1, 0.4, "x"),
                (12, r + third + 12, 1, 0.88, "p"), (13, r + 7, 1, 0.7, "n"), (14, nr - 2, 1, 0.75, "n"), (15, nr - 1, 1, 0.72, "n")]
        if isinstance(CHORDS.get(bar), tuple):  # second chord on beat 3
            s2 = chord_at(bar, 3)
            r2 = ROOT[s2] + (12 if ROOT[s2] < 33 else 0)
            line = line[:8] + [(8, r2, 2, 0.95, "n"), (10, r2 + 12, 1, 0.85, "p"), (11, r2, 1, 0.4, "x"), (12, r2 + 7, 1, 0.8, "n"),
                               (13, r2 + 10, 1, 0.75, "n"), (14, nr - 2, 1, 0.75, "n"), (15, nr - 1, 1, 0.72, "n")]
        for step, note, ln, v, kind in line:
            t = a.st(bar, step)
            if kind == "x":
                a.put("bass", inst.bass_ghost(note, v * 0.9 * vel, seed=self._s()), t)
            else:
                a.put("bass", inst.bass(note, g.steps(ln) * 0.86, v * vel, slap=0.85 if kind == "p" else 0.15, seed=self._s()), t)

    def ep_chord(self, t, sym, dur, vel=0.6, track="ep", voicing=None):
        for i, n in enumerate(voicing or V[sym]):
            self.a.put(track, inst.ep(n, dur, vel * (0.9 + 0.1 * (i == 3)), seed=self._s()), t + 0.002 * i)

    def ep_comp(self, bar, vel=0.6):
        a = self.a
        for step, ln, v in ((0, 1, 0.5), (3, 2, 0.62), (6, 1, 0.5), (9, 1, 0.45), (11, 3, 0.6)):
            sym = chord_at(bar, 1 + step / 4)
            self.ep_chord(a.st(bar, step, 1.5), sym, self.g.steps(ln) * 0.8, v * vel / 0.6)

    def gtr_chops(self, bar, vel=0.6):
        a = self.a
        for s in (2, 6, 10, 14):
            sym = chord_at(bar, 1 + s / 4)
            ns = sorted(((n - 52) % 12) + 52 for n in V[sym])
            a.put("gtr", inst.guitar_chop(ns, 0.07, vel * float(a.rng.uniform(0.9, 1.05)), wah=0.5, seed=self._s()), a.st(bar, s, 2.0))

    def stab(self, t, sym, dur=0.16, vel=0.9, low=True, up=12):
        ns = [n + up for n in V[sym]]
        if low:
            ns = [ROOT[sym] + 24] + ns
        self.a.put("brass", inst.brass(ns, dur, vel, attack=0.004, seed=self._s()), t)

    def blip(self, t, sym, vel=0.55):
        """Muted short brass 'blip' on a UI click (two top voices only)."""
        ns = [n + 12 for n in V[sym][-2:]]
        self.a.put("brass", inst.brass(ns, 0.09, vel, attack=0.003, scoop_cents=30.0, seed=self._s()), t)

    def strings_pad(self, t, sym, dur, vel=0.32, attack=0.25, release=0.5):
        ns = V[sym] + [V[sym][-1] + 12]
        self.a.put("strings", inst.strings(ns, dur, vel, attack=attack, release=release, seed=self._s()), t)

    def glock_lick(self, bar, notes, step0=0, vel=0.45):
        for k, nt in enumerate(notes):
            self.a.put("glock", inst.glock(nn(nt), vel * (1 - 0.06 * k), 0.8, seed=self._s()), self.a.st(bar, step0 + k * 2))


# ------------------------------------------------------------------------------------------------- compose
def compose(a: Arranger) -> dict:
    sc = Score(a)
    g = a.g
    T = g.t

    # ---- Bars 1-2: cold open — the red string snaps, the board appears, the codename slams ---------------------
    a.hit("kick", "kick_boom", T(1, 1), 0.9)
    a.put("bass", inst.sub(nn("D1"), 1.2, 0.6, release=0.6), T(1, 1))
    for bar, step, name, ln, v in SPY:
        sc.bass_note(a.st(bar, step), nn(name), g.steps(ln) * 0.8, v, slap=0.15)
    for bar in (1, 2):
        a.drum("rim", bar, "....x.......x...", vel=0.85)
        a.drum("hat", bar, "x.x.x.x.x.x.x.x.", vel=0.5, human_ms=2)
    a.drum("kick", 2, "X.........X.....", vel=0.85)
    sc.ep_chord(T(1, 2), "Dm9", g.bar * 1.4, 0.42)
    sc.strings_pad(T(1, 2), "Dm9", g.bar * 1.5, vel=0.22, attack=0.6, release=0.6)
    sc.glock_lick(1, ["D6", "F6", "A6", "C7"], step0=8, vel=0.3)
    # codename slam [2,1] (two ransom pops on the 8ths: [2,1] and [2,2])
    sc.crash(T(2, 1), 0.9)
    sc.stab(T(2, 1), "Dm9", dur=0.22, vel=1.0)
    a.hit("snare", "snare", T(2, 1), 0.9)
    sc.stab(T(2, 2), "Dm9", dur=0.12, vel=0.75, low=False)
    a.hit("kick", "kick", T(2, 2), 0.8)

    # ---- Bars 3-10: the five-step plan (missions 01-04), groove A ---------------------------------------------
    for bar in range(3, 11):
        sc.groove(bar, bar - 3, vel=0.95)
        sc.funk_bass(bar)
        sc.ep_comp(bar)
        if bar >= 7:
            sc.gtr_chops(bar, 0.55)
    for bar in (3, 5, 9):   # mission titles (the shutter wipes)
        sc.crash(T(bar, 1), 0.8)
        sc.stab(T(bar, 1), chord_at(bar), dur=0.2, vel=0.95)
    sc.stab(T(7, 1), "Bbmaj9", dur=0.2, vel=0.95)  # mission 03 (Yuan's photo slams)
    sc.crash(T(7, 1), 0.7)
    sc.stab(T(7, 3), "Bbmaj9", dur=0.14, vel=0.85)  # Dian's photo
    sc.stab(T(4, 1), "G13", dur=0.18, vel=0.9)     # LIVE stamp
    sc.stab(T(8, 3), "A7#9", dur=0.2, vel=0.95)     # 1 host + up to 20 viewers stamp
    a.hit("snare", "snare", T(8, 3), 0.8)
    for (bar, beat), sym in (((3, 2), "Dm9"), ((3, 4.5), "Dm9"), ((5, 2), "Dm9"), ((6, 2.5), "G13"), ((10, 4), "G13")):
        sc.blip(T(bar, beat), sym)
    # spy glock answers between the clicks
    sc.glock_lick(4, ["A6", "G6", "F6", "E6"], step0=8, vel=0.32)
    sc.glock_lick(6, ["D6", "E6", "F6", "A6"], step0=8, vel=0.32)
    sc.glock_lick(8, ["C#7", "A6", "G6", "E6"], step0=10, vel=0.3)
    sc.strings_pad(T(7, 1), "Bbmaj9", g.bar * 0.98, vel=0.24, attack=0.3)
    sc.strings_pad(T(8, 1), "A7#9", g.bar * 0.98, vel=0.26, attack=0.3)

    # ---- Bars 11-13: hand over the controls — tension, a true stop for the cut-in, the big ALLOW ------------------
    a.drum("kick", 11, "X...X...X...X...", vel=0.85)
    a.drum("rim", 11, "....x.......x...", vel=0.85)
    a.drum("hat", 11, "x.x.x.x.x.x.x.x.", vel=0.62)
    for s in range(0, 16, 2):
        sc.bass_note(a.st(11, s), ROOT["Bbmaj9"] + (12 if s % 4 else 0), g.steps(1.3), 0.85, slap=0.4 if s % 4 else 0.1)
    sc.ep_chord(T(11, 1), "Bbmaj9", g.beat * 1.8, 0.5)
    sc.ep_chord(T(11, 3), "Bbmaj9", g.beat * 1.8, 0.5)
    sc.strings_pad(T(11, 1), "Bbmaj9", g.bar * 0.98, vel=0.3, attack=0.4)
    sc.blip(T(11, 2), "Bbmaj9")
    # bar 12 beats 1-2.5: silence (cue stop) for Yuan's request; then the build into [13,1]
    for k in range(6):
        a.hit("snare", "snare", T(12, 3) + k * g.beat / 3, 0.3 + 0.1 * k)
    for k in range(4):
        a.hit("snare", "snare", T(12, 4) + k * g.beat / 4, 0.6 + 0.08 * k)
    sc.strings_pad(T(12, 3), "A7sus4", g.beat * 2.0, vel=0.4, attack=0.6, release=0.05)
    sc.bass_note(T(12, 3), ROOT["A7sus4"] + 12, g.beat * 1.9, 0.9, slap=0.2)
    t = T(13, 1)   # ALLOW
    sc.crash(t)
    a.hit("kick", "kick_boom", t, 1.0)
    a.put("timp", drums.timpani(33, 1.0, seed=sc._s()), t)
    sc.stab(t, "A7b9", dur=0.5, vel=1.0)
    sc.ep_chord(t, "A7b9", 0.6, 0.7)
    sc.bass_note(t, ROOT["A7b9"], 0.6, 1.0, slap=0.6)
    a.drum("hat", 13, "....x.x.x.x.x.x.", vel=0.6)
    a.drum("kick", 13, "........X.....x.", vel=0.85)
    a.drum("snare", 13, "............X.xX", vel=0.85)
    for s, name in ((8, "A1"), (10, "C2"), (12, "C#2"), (14, "E2")):
        sc.bass_note(a.st(13, s), nn(name), g.steps(1.6), 0.85, slap=0.3)
    sc.ep_chord(T(13, 3), "A7b9", g.beat * 1.8, 0.5)

    # ---- Bars 14-16: VS — full groove on the ride + the brass heist hook ----------------------------------------
    sc.crash(T(14, 1))
    a.put("timp", drums.timpani(38, 0.9, seed=sc._s()), T(14, 1))
    for bar in (14, 15, 16):
        sc.groove(bar, bar, vel=1.0, ride=True)
        sc.funk_bass(bar, nxt=17)
        sc.ep_comp(bar, vel=0.5)
        sc.gtr_chops(bar, 0.6)
        sc.strings_pad(T(bar, 1), chord_at(bar), g.bar * 0.98, vel=0.26, attack=0.15)
    for bar, step, ln, note in HOOK:
        n0 = nn(note)
        dur = g.steps(ln) * (0.9 if ln < 4 else 0.97)
        a.put("brass", inst.brass([n0, under(n0, chord_at(bar, 1 + step / 4))], dur, 0.85, attack=0.008, scoop_cents=45.0,
                                  release=0.08, seed=sc._s()), a.st(bar, step))

    # ---- Bar 17: MISSION COMPLETE — band hit and a brass fall --------------------------------------------------
    t = T(17, 1)
    sc.crash(t)
    a.hit("kick", "kick_boom", t, 1.0)
    a.hit("snare", "snare", t, 1.0)
    a.put("timp", drums.timpani(33, 1.0, seed=sc._s()), t)
    sc.bass_note(t, ROOT["A7#9"], 0.6, 1.0, slap=0.7)
    a.put("bass", inst.sub(nn("A1"), 0.7, 0.5), t)
    sc.ep_chord(t, "A7#9", 0.9, 0.7)
    fall = [(0.0, 0.3, nn("D6"), 1.0), (0.5, 0.18, nn("C#6"), 0.8), (0.75, 0.18, nn("A5"), 0.75), (1.0, 0.5, nn("E5"), 0.7)]
    for s0, d, n0, v in fall:
        a.put("brass", inst.brass([n0, n0 - 4], d, 0.9 * v, attack=0.005, scoop_cents=20.0, release=0.15, seed=sc._s()), t + s0)
    a.drum("hat", 17, "........x.x.x.x.", vel=0.55)
    a.drum("kick", 17, "........X.......", vel=0.8)
    a.drum("rim", 17, "............x...", vel=0.8)
    for s, name in ((8, "A1"), (12, "Bb1"), (14, "B1")):
        sc.bass_note(a.st(17, s), nn(name), g.steps(1.8), 0.85, slap=0.2)

    # ---- Bars 18-20: dossier — stop-time stamps, ii-V-I into F major --------------------------------------------
    stamps = [((18, 3), "Gm9", "G2"), ((19, 1), "C13", "C2"), ((19, 3), "C13", "E2"), ((20, 1), "Fmaj9", "F2"),
              ((20, 2), "Fmaj9", "A2"), ((20, 3), "Fmaj9", "C3")]
    for k, ((bar, beat), sym, bn) in enumerate(stamps):
        t = T(bar, beat)
        a.hit("kick", "kick", t, 1.0)
        a.hit("snare", "snare", t, 0.82 + 0.03 * k)
        a.hit("clap", "clap", t, 0.65)
        sc.stab(t, sym, dur=0.14, vel=0.88 + 0.02 * k)
        sc.ep_chord(t, sym, 0.18, 0.55)
        sc.bass_note(t, nn(bn), 0.2, 1.0, slap=0.8)
    sc.ep_chord(T(18, 1), "Gm9", g.beat * 1.8, 0.45)
    sc.strings_pad(T(18, 1), "Gm9", g.beat * 1.9, vel=0.22, attack=0.2)
    for bar, ticks in ((18, (0, 2, 4, 6, 10, 14)), (19, (2, 6, 10, 14)), (20, (14,))):
        for s in ticks:
            a.hit("hat", "hat", a.st(bar, s), 0.3)
    sc.crash(T(20, 3), 0.6)
    a.drum("snare", 20, "............oxXX")

    # ---- Bars 21-23: end card — F6/9, four ransom pops, the sonic logo, ring out ------------------------------------
    t = T(21, 1)
    sc.crash(t)
    a.hit("kick", "kick_boom", t, 1.0)
    a.put("brass", inst.brass([nn("F3"), nn("C4")] + [n + 12 for n in V["F6/9"]], 0.6, 0.95, release=0.4, seed=sc._s()), t)
    sc.bass_note(t, nn("F1"), 1.8, 1.0, slap=0.4)
    a.put("bass", inst.sub(nn("F1"), 1.8, 0.55, release=0.6), t)
    sc.ep_chord(t, "F6/9", g.bar * 0.95, 0.6)
    sc.strings_pad(t, "F6/9", g.bar * 2.6, vel=0.3, attack=0.1, release=1.2)
    a.drum("hat", 21, "..x...x...x...x.", vel=0.5)
    a.drum("rim", 21, "...x...x...x...x", vel=0.6)   # under the four ransom pops ([21,1.5] [21,2.5] [21,3.5] [21,4.5])
    a.drum("kick", 21, "........X.......", vel=0.7)
    # [22,1] sonic logo: leave the top clear; a soft chord bed and a glock arpeggio after it
    sc.ep_chord(T(22, 1), "F6/9", g.bar * 1.6, 0.42)
    sc.bass_note(T(22, 1), nn("F1"), g.bar * 1.5, 0.8, slap=0.1)
    for k, nt in enumerate(("F6", "A6", "C7", "D7", "G7")):
        a.put("glock", inst.glock(nn(nt), 0.42 - 0.05 * k, 1.4, seed=sc._s()), T(22, 2.5) + k * g.beat / 2)
    return {}
