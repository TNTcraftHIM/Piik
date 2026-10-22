"""Film A score — 预告状 · THE CALLING CARD. Syncopated acid-jazz funk, 128 BPM, A minor -> C major.

Bar-by-bar arrangement that follows films/A/cues.json (sections, chords, hits, stops). Hits listed in the cue
sheet are placed with exact beat times (Arranger.bt); groove notes use swung 16ths (Arranger.st).
Tracks named here are mixed in build.py.
"""
from __future__ import annotations

import numpy as np

from engine.core import nn
from engine import inst, drums, dsp
from engine.arrange import Arranger

# ----------------------------------------------------------------------------------------------- harmony
V = {  # mid-register keyboard voicings (rootless/close), C4-ish
    "Am9": ["C4", "E4", "G4", "B4"], "D9": ["C4", "E4", "F#4", "A4"], "Fmaj9": ["C4", "E4", "G4", "A4"],
    "E7#9": ["G#3", "D4", "G4", "B4"], "E7sus4": ["A3", "D4", "E4", "B4"], "Fmaj7": ["C4", "E4", "F4", "A4"],
    "G6": ["B3", "D4", "E4", "G4"], "Em7": ["B3", "D4", "E4", "G4"], "Am7": ["C4", "E4", "G4", "A4"],
    "Dm9": ["C4", "E4", "F4", "A4"], "G13": ["B3", "E4", "F4", "A4"], "E7b9": ["D4", "F4", "G#4", "B4"],
    "Am": ["A3", "C4", "E4"], "Bm7b5": ["A3", "D4", "F4", "B4"], "C6/9": ["E4", "G4", "A4", "D5"],
    "Cmaj9": ["E4", "G4", "B4", "D5"],
}
ROOT = {"Am9": "A", "D9": "D", "Fmaj9": "F", "E7#9": "E", "E7sus4": "E", "Fmaj7": "F", "G6": "G", "Em7": "E",
        "Am7": "A", "Dm9": "D", "G13": "G", "E7b9": "E", "Am": "A", "Bm7b5": "B", "C6/9": "C", "Cmaj9": "C"}
# Stop-time planing voicings (bars 27-28): stacked diatonic sevenths, every voice climbing.
ST_V = {"Dm9": ["D4", "F4", "A4", "C5", "E5"], "Em7": ["E4", "G4", "B4", "D5"], "Fmaj7": ["F4", "A4", "C5", "E5"],
        "G6": ["G4", "B4", "D5", "E5"], "Am9": ["A4", "C5", "E5", "G5", "B5"], "Bm7b5": ["B4", "D5", "F5", "A5"],
        "C6/9": ["C5", "E5", "G5", "A5", "D6"]}

CHORDS = {1: "Am9", 2: "Am9", 3: "Am9", 4: "D9", 5: "Fmaj9", 6: "E7#9", 7: "Am9", 8: "D9", 9: "Am9", 10: "D9",
          11: "Fmaj9", 12: "E7sus4", 13: "Fmaj7", 14: "G6", 15: "Em7", 16: "Am7", 17: "Dm9", 18: "G13",
          19: "E7sus4", 20: "E7b9", 21: "Am", 22: "Am", 23: "Fmaj7", 24: "G6", 25: "Em7", 29: "Fmaj7", 30: "G6",
          31: ("Em7", "Am7"), 32: ("Dm9", "G13"), 33: "Cmaj9", 34: "Cmaj9"}


def chord_at(bar, beat=1.0):
    c = CHORDS.get(bar)
    if isinstance(c, tuple):
        return c[0] if beat < 3 else c[1]
    return c


def N(names):
    return [nn(x) for x in names]


def root_note(sym, octave):
    return nn(ROOT[sym] + str(octave))


C_MAJOR = [0, 2, 4, 5, 7, 9, 11]


def diatonic(note, degrees):
    """Move a C-major scale note by `degrees` scale steps (negative = down)."""
    pc, octv = note % 12, note // 12
    idx = min(range(7), key=lambda i: abs(C_MAJOR[i] - pc))
    k = idx + degrees
    return 12 * (octv + k // 7) + C_MAJOR[k % 7]


# ---------------------------------------------------------------------------------------------- patterns
GA_K = ["X......x..x.....", "X......x..x...x."]
GA_S = "....X.......X..."
GA_G = "......g..g....g."
GA_H = "xoxoxoxoxoxoxoxo"
CH_K = ["X.....x.X..x....", "X.....x.X..x..x."]
CH_HC = "xoxoxo.oxoxoxo.o"   # closed, leaving the open-hat slots
CH_HO = "......x.......x."
FI_K = ["X...X...X...X...", "X...X...X...X.x."]
FI_HC = "xo.oxo.oxo.oxo.o"
FI_HO = "..x...x...x...x."

# Bass lines: (step, note, length_steps, velocity, kind) kind: n=normal p=slap/pop x=ghost
B_AM = [(0, "A1", 2, 1.0, "n"), (3, "A2", 1, 0.9, "p"), (4, "A1", 1, 0.4, "x"), (6, "G2", 1, 0.7, "n"),
        (7, "A2", 1, 0.85, "n"), (8, "E2", 2, 0.9, "n"), (10, "A1", 1, 0.8, "n"), (11, "A1", 1, 0.4, "x"),
        (12, "C3", 1, 0.9, "p"), (13, "A2", 1, 0.7, "n"), (14, "G2", 1, 0.75, "n"), (15, "E2", 1, 0.7, "n")]
B_D9 = [(0, "D2", 2, 1.0, "n"), (3, "D3", 1, 0.9, "p"), (4, "D2", 1, 0.4, "x"), (6, "C3", 1, 0.7, "n"),
        (7, "D3", 1, 0.85, "n"), (8, "A2", 2, 0.9, "n"), (10, "D2", 1, 0.8, "n"), (11, "D2", 1, 0.4, "x"),
        (12, "F#2", 1, 0.85, "n"), (13, "G2", 1, 0.8, "n"), (14, "G#2", 1, 0.8, "n"), (15, "A2", 1, 0.35, "x")]
B_D9_TO_F = B_D9[:10] + [(12, "C3", 1, 0.9, "p"), (14, "A2", 1, 0.8, "n"), (15, "G2", 1, 0.75, "n")]
B_G6 = [(0, "G1", 2, 1.0, "n"), (3, "G2", 1, 0.9, "p"), (4, "G1", 1, 0.4, "x"), (6, "E2", 1, 0.7, "n"),
        (7, "G2", 1, 0.85, "n"), (8, "D2", 2, 0.9, "n"), (10, "G1", 1, 0.8, "n"), (11, "G1", 1, 0.4, "x"),
        (12, "B2", 1, 0.9, "p"), (13, "A2", 1, 0.7, "n"), (14, "G2", 1, 0.75, "n"), (15, "E2", 1, 0.7, "n")]
B_EM = [(0, "E1", 2, 1.0, "n"), (3, "E2", 1, 0.9, "p"), (4, "E1", 1, 0.4, "x"), (6, "D2", 1, 0.7, "n"),
        (7, "E2", 1, 0.85, "n"), (8, "B1", 2, 0.9, "n"), (10, "E1", 1, 0.8, "n"), (11, "E1", 1, 0.4, "x"),
        (12, "G2", 1, 0.9, "p"), (13, "E2", 1, 0.7, "n"), (14, "D2", 1, 0.75, "n"), (15, "B1", 1, 0.7, "n")]
B_DM = [(0, "D2", 2, 1.0, "n"), (3, "D3", 1, 0.9, "p"), (4, "D2", 1, 0.4, "x"), (6, "C3", 1, 0.7, "n"),
        (7, "D3", 1, 0.85, "n"), (8, "A2", 2, 0.9, "n"), (10, "D2", 1, 0.8, "n"), (11, "D2", 1, 0.4, "x"),
        (12, "F2", 1, 0.9, "p"), (13, "E2", 1, 0.7, "n"), (14, "D2", 1, 0.75, "n"), (15, "C2", 1, 0.7, "n")]
B_G13 = [(0, "G1", 2, 1.0, "n"), (3, "G2", 1, 0.9, "p"), (4, "G1", 1, 0.4, "x"), (6, "F2", 1, 0.7, "n"),
         (7, "G2", 1, 0.85, "n"), (8, "D2", 2, 0.9, "n"), (10, "G1", 1, 0.8, "n"), (11, "G1", 1, 0.4, "x"),
         (12, "B1", 1, 0.85, "n"), (13, "C2", 1, 0.8, "n"), (14, "D2", 1, 0.85, "n"), (15, "D#2", 1, 0.8, "n")]
B_F = [(0, "F1", 2, 1.0, "n"), (3, "F2", 1, 0.9, "p"), (4, "F1", 1, 0.4, "x"), (6, "F1", 1, 0.75, "n"),
       (7, "F2", 1, 0.85, "n"), (8, "C2", 2, 0.9, "n"), (10, "F1", 1, 0.8, "n"), (11, "F1", 1, 0.4, "x"),
       (12, "A2", 1, 0.9, "p"), (13, "G2", 1, 0.7, "n"), (14, "F2", 1, 0.75, "n"), (15, "E2", 1, 0.7, "n")]

# Lead hook (bar, step, len_steps, note, vel)
HOOK1 = [(13, 12, 1, "G4", 0.7), (13, 13, 1, "A4", 0.75), (13, 14, 2, "C5", 0.85),
         (14, 0, 2, "D5", 0.95), (14, 2, 2, "E5", 0.85), (14, 4, 3, "G5", 0.95), (14, 7, 1, "E5", 0.75),
         (14, 8, 2, "D5", 0.85), (14, 10, 2, "B4", 0.8), (14, 12, 4, "D5", 0.85),
         (15, 0, 2, "E5", 0.9), (15, 2, 2, "G5", 0.85), (15, 4, 3, "B5", 0.95), (15, 7, 1, "A5", 0.75),
         (15, 8, 2, "G5", 0.85), (15, 10, 2, "E5", 0.8), (15, 12, 2, "G5", 0.85), (15, 14, 2, "A5", 0.85),
         (16, 0, 4, "C6", 1.0), (16, 4, 2, "B5", 0.85), (16, 6, 2, "A5", 0.8), (16, 8, 2, "G5", 0.85),
         (16, 10, 6, "E5", 0.9)]
HOOK2 = [(23, 0, 2, "C5", 0.95), (23, 2, 2, "E5", 0.85), (23, 4, 3, "A5", 1.0), (23, 7, 1, "G5", 0.75),
         (23, 8, 2, "E5", 0.85), (23, 10, 2, "C5", 0.8), (23, 12, 2, "E5", 0.85), (23, 14, 2, "F5", 0.85),
         (24, 0, 2, "G5", 0.95), (24, 2, 2, "A5", 0.85), (24, 4, 3, "B5", 1.0), (24, 7, 1, "A5", 0.75),
         (24, 8, 2, "G5", 0.85), (24, 10, 2, "E5", 0.8), (24, 12, 2, "D5", 0.85), (24, 14, 2, "E5", 0.9),
         (25, 0, 4, "G5", 1.0), (25, 4, 2, "B5", 1.0), (25, 8, 8, "E6", 1.0)]
JINGLE = [(32, 0, 2, "E5", 0.9), (32, 2, 2, "G5", 0.85), (32, 4, 2, "A5", 0.9), (32, 6, 2, "C6", 0.9),
          (32, 8, 2, "D6", 0.95), (32, 10, 2, "C6", 0.85), (32, 12, 2, "A5", 0.85), (32, 14, 2, "G5", 0.85),
          (33, 0, 18, "C6", 1.0)]


# ------------------------------------------------------------------------------------------------ helpers
class Score:
    def __init__(self, a: Arranger):
        self.a = a
        self.g = a.g
        self.seed = 0

    def _s(self):
        self.seed += 1
        return self.seed

    # drums ------------------------------------------------------------------------------------------
    def groove_a(self, bar, variant=0, vel=1.0):
        a = self.a
        a.drum("kick", bar, GA_K[variant], vel=vel)
        a.drum("snare", bar, GA_S, vel=0.95 * vel)
        a.drum("snare", bar, GA_G, kind="snare_ghost", vel=0.85 * vel, human_ms=2)
        a.drum("hat", bar, GA_H, vel=0.75 * vel, human_ms=2.5, skip=(14,) if variant == 1 else ())
        if variant == 1:
            a.drum("ohat", bar, "..............x.", vel=0.55 * vel)

    def groove_chorus(self, bar, variant=0, vel=1.0, shaker=True):
        a = self.a
        a.drum("kick", bar, CH_K[variant], vel=vel)
        a.drum("snare", bar, "....X.......X...", vel=0.95 * vel)
        a.drum("clap", bar, "....x.......x...", vel=0.7 * vel)
        a.drum("snare", bar, "..g.......g....g", kind="snare_ghost", vel=0.8 * vel, human_ms=2)
        a.drum("hat", bar, CH_HC, vel=0.7 * vel, human_ms=2.5)
        a.drum("ohat", bar, CH_HO, vel=0.5 * vel)
        if shaker:
            a.drum("shaker", bar, "xoxoxoxoxoxoxoxo", vel=0.6 * vel, human_ms=3, pan=0.35)

    def groove_fight(self, bar, variant=0, vel=1.0):
        a = self.a
        a.drum("kick", bar, FI_K[variant], vel=vel)
        a.drum("snare", bar, "....X.......X...", vel=1.0 * vel)
        a.drum("clap", bar, "....x.......x...", vel=0.8 * vel)
        a.drum("hat", bar, FI_HC, vel=0.75 * vel, human_ms=2)
        a.drum("ohat", bar, FI_HO, vel=0.55 * vel)
        a.drum("shaker", bar, "xoxoxoxoxoxoxoxo", vel=0.7 * vel, human_ms=3, pan=0.35)

    def crash(self, t, vel=1.0):
        self.a.hit("cym", "crash", t, vel, variants=3)

    def tom(self, t, note, vel=0.9, decay=0.24):
        self.a.put("tom", drums.tom(note, vel, decay, seed=self._s()), t, pan=float(np.clip((note - 46) / 14, -0.6, 0.6)))

    def snare_fill(self, bar, steps, v0=0.5, v1=1.0):
        for k, s in enumerate(steps):
            v = v0 + (v1 - v0) * k / max(1, len(steps) - 1)
            self.a.hit("snare", "snare", self.a.st(bar, s), v)

    # pitched ------------------------------------------------------------------------------------------
    def bass_line(self, bar, line, vel=1.0, track="bass"):
        a = self.a
        for step, name, ln, v, kind in line:
            t = a.st(bar, step)
            dur = self.g.steps(ln) * 0.88
            n = nn(name)
            if kind == "x":
                clip = inst.bass_ghost(n, v * 0.9 * vel, seed=self._s())
            else:
                clip = inst.bass(n, dur, v * vel, slap=0.85 if kind == "p" else 0.15, seed=self._s())
            a.put(track, clip, t)

    def bass_note(self, t, name, dur, vel=1.0, slap=0.3, track="bass"):
        self.a.put(track, inst.bass(nn(name), dur, vel, slap=slap, seed=self._s()), t)

    def ep_chord(self, t, sym, dur, vel=0.6, track="ep", voicing=None):
        ns = N(voicing or V[sym])
        for i, n in enumerate(ns):
            self.a.put(track, inst.ep(n, dur, vel * (0.9 + 0.1 * (i == len(ns) - 1)), seed=self._s()), t + 0.002 * i)

    def ep_comp(self, bar, sym=None, vel=0.6, style="comp"):
        sym = sym or chord_at(bar)
        a = self.a
        if style == "comp":
            for step, ln, v in ((0, 1, 0.5), (3, 2, 0.62), (6, 1, 0.5), (9, 1, 0.45), (11, 3, 0.6)):
                s = chord_at(bar, 1 + step / 4)
                self.ep_chord(a.st(bar, step, 1.5), s or sym, self.g.steps(ln) * 0.8, v * vel / 0.6)
        elif style == "half":
            for step in (0, 8):
                s = chord_at(bar, 1 + step / 4) or sym
                self.ep_chord(a.st(bar, step), s, self.g.steps(7), 0.5 * vel / 0.6)
            self.ep_chord(a.st(bar, 14, 1.5), chord_at(bar, 4.5) or sym, self.g.steps(1) * 0.8, 0.45 * vel / 0.6)
        elif style == "hold":
            self.ep_chord(a.st(bar, 0), sym, self.g.bar * 0.97, 0.5 * vel / 0.6)

    def gtr_chops(self, bar, vel=0.6, steps=(2, 6, 10, 14), ghosts=True):
        a = self.a
        if ghosts:
            for s in (1, 5, 9, 13):
                sym = chord_at(bar, 1 + s / 4)
                if sym:
                    ns = sorted(((n - 52) % 12) + 52 for n in N(V[sym]))
                    a.put("gtr", inst.guitar_chop(ns, 0.022, vel * 0.32, wah=0.3, seed=self._s()), a.st(bar, s, 2.0))
        for s in steps:
            sym = chord_at(bar, 1 + s / 4)
            if not sym:
                continue
            ns = sorted(((n - 52) % 12) + 52 for n in N(V[sym]))
            a.put("gtr", inst.guitar_chop(ns, 0.07, vel * float(a.rng.uniform(0.9, 1.05)), wah=0.45 + 0.1 * (s % 4 == 2),
                                          seed=self._s()), a.st(bar, s, 2.0))

    def brass_stab(self, t, sym, dur=0.17, vel=0.95, low=True, up=True, voicing=None, track="brass"):
        ns = [n + (12 if up else 0) for n in N(voicing or V[sym])]
        if low:
            ns = [root_note(sym, 3)] + ns
        self.a.put(track, inst.brass(ns, dur, vel, attack=0.004, seed=self._s()), t)

    def strings_pad(self, t, sym, dur, vel=0.35, attack=0.2, up=True, release=0.5):
        ns = N(V[sym])
        if up:
            ns = ns + [ns[-1] + 12]
        self.a.put("strings", inst.strings(ns, dur, vel, attack=attack, release=release, seed=self._s()), t)

    def lead_phrase(self, events, track="lead", glock=True, vel_bright=1.0):
        a = self.a
        t0 = a.st(events[0][0], events[0][1])
        evs = []
        for bar, step, ln, note, v in events:
            s = a.st(bar, step) - t0
            evs.append((s, self.g.steps(ln) * 0.92, nn(note), v))
        a.put(track, inst.lead(evs, vel_bright=vel_bright, seed=self._s()), t0)
        if glock:
            for s, d, n, v in evs:
                a.put("glock", inst.glock(n + 12, 0.45 * v, 0.9, seed=self._s()), t0 + s)


# ------------------------------------------------------------------------------------------------- compose
def compose(a: Arranger) -> dict:
    """Write every part into the arranger's tracks. Returns metadata used by the mixer (stop-exempt tracks...)."""
    sc = Score(a)
    g = a.g
    T = g.t

    # ---- Bars 1-2: intro, will be heard 'through a TV' (filtered in build.py) ----------------------------
    for bar in (1, 2):
        sc.groove_a(bar, bar - 1, vel=0.85)
        sc.ep_comp(bar, "Am9", vel=0.55)
        sc.gtr_chops(bar, 0.45)
    # bass slide-in breaks out of the TV at [2,3]
    a.put("bass_slide", inst.bass(nn("A1"), 0.84, 0.95, slap=0.35, glide_from=nn("E1"), glide_t=0.55, seed=7), T(2, 3))

    # ---- Bars 3-4: groove A, stabs on panel slams -----------------------------------------------------
    sc.crash(T(3, 1))
    for bar, line in ((3, B_AM), (4, B_D9)):
        sc.groove_a(bar, bar - 3)
        sc.bass_line(bar, line)
        sc.ep_comp(bar)
        sc.gtr_chops(bar)
    sc.brass_stab(T(3, 1), "Am9")
    sc.brass_stab(T(3, 3), "Am9", vel=0.85)
    sc.brass_stab(T(4, 1), "D9")

    # ---- Bars 5-6: idea — thin out ----------------------------------------------------------------------
    a.drum("kick", 5, "X.......X.......", vel=0.85)
    a.drum("hat", 5, "gggggggggggggggg", vel=0.9, human_ms=2)
    sc.ep_comp(5, "Fmaj9", vel=0.6, style="hold")
    sc.strings_pad(T(5, 1), "Fmaj9", g.bar * 0.95, vel=0.3, attack=0.35)
    sc.bass_note(T(5, 1), "F1", g.steps(7.5), 0.9, slap=0.1)
    for step, name in ((8, "A1"), (10, "C2"), (12, "E2")):
        sc.bass_note(g.t(5, 1 + step / 4), name, g.steps(1.8), 0.85, slap=0.4)
    # [6,1] band hit — choked crash so [6,3] stays clear for the mascot chirp
    a.put("cym", dsp.endfade(drums.crash(0.85, dur=0.75, seed=61), 160.0), T(6, 1))
    a.hit("kick", "kick", T(6, 1), 1.0)
    a.hit("snare", "snare", T(6, 1), 0.9)
    sc.brass_stab(T(6, 1), "E7#9", dur=0.24, vel=1.0)
    sc.ep_chord(T(6, 1), "E7#9", 0.3, 0.7)
    sc.bass_note(T(6, 1), "E1", 0.3, 1.0, slap=0.8)
    a.drum("hat", 6, "..g.g.g.........", vel=1.0)
    # space at [6,3] for the mascot chirp, then a pickup fill
    a.hit("kick", "kick", a.st(6, 12), 0.7)
    sc.snare_fill(6, (12, 13, 14, 15), 0.45, 0.9)
    for step, name in ((12, "E2"), (13, "G2"), (14, "G#2")):
        sc.bass_note(a.st(6, step), name, g.steps(0.9), 0.8, slap=0.3)

    # ---- Bars 7-10: steps 1 & 2 (verse) -------------------------------------------------------------------
    lines = {7: B_AM, 8: B_D9, 9: B_AM, 10: B_D9_TO_F}
    for bar in (7, 8, 9, 10):
        sc.groove_a(bar, (bar - 7) % 2)
        sc.bass_line(bar, lines[bar])
        sc.ep_comp(bar)
        sc.gtr_chops(bar)
    sc.crash(T(8, 1), 0.8)
    sc.brass_stab(T(8, 1), "D9")
    sc.brass_stab(T(8, 3), "D9", vel=1.0)
    a.hit("snare", "snare", T(8, 3), 0.8)
    a.hit("kick", "kick", T(8, 3), 0.9)
    sc.brass_stab(T(9, 2), "Am9", dur=0.12, vel=0.7, low=False)

    # ---- Bars 11-12: step 3 build -------------------------------------------------------------------------
    a.drum("kick", 11, "X...x...X...x...")
    a.drum("snare", 11, "....X.......X...", vel=0.9)
    a.drum("hat", 11, GA_H, vel=0.8, human_ms=2)
    for k, s in enumerate(range(0, 16, 2)):
        sc.bass_note(a.st(11, s), "F1" if k % 2 == 0 else "F2", g.steps(1.6), 0.85 + 0.05 * (k % 2), slap=0.5 * (k % 2))
    sc.ep_comp(11, "Fmaj9")
    sc.gtr_chops(11)
    sc.strings_pad(T(11, 1), "Fmaj9", g.bar * 0.98, vel=0.28, attack=1.2, release=0.1)
    a.drum("kick", 12, "X...x...x.......")
    for k in range(8):  # 16ths beats 1-2
        a.hit("snare", "snare", a.st(12, k), 0.32 + 0.05 * k)
    for k in range(8):  # 32nds beat 3
        a.hit("snare", "snare", T(12, 3) + k * g.beat / 8, 0.7 + 0.04 * k)
    for k, s in enumerate(range(0, 12, 2)):
        sc.bass_note(a.st(12, s), "E1" if k % 2 == 0 else "E2", g.steps(1.6), 0.8 + 0.04 * k, slap=0.5 * (k % 2))
    sc.ep_chord(T(12, 1), "E7sus4", g.beat * 0.9, 0.55)
    sc.ep_chord(T(12, 3), "E7sus4", g.beat * 0.9, 0.65)
    sc.strings_pad(T(12, 1), "E7sus4", g.beat * 2.9, vel=0.4, attack=1.0, release=0.05)
    # [12,4] gap: nothing

    # ---- Bar 13: FULL HOUSE landings --------------------------------------------------------------------------
    sc.crash(T(13, 1))
    for beat, tn, bn in ((1, 41, "F1"), (2, 45, "A1"), (3, 48, "C2")):
        t = T(13, beat)
        a.hit("kick", "kick", t, 1.0)
        sc.tom(t, tn + 12, 0.95, decay=0.2)
        sc.brass_stab(t, "Fmaj7", dur=0.15, vel=0.9 + 0.04 * beat)
        sc.ep_chord(t, "Fmaj7", 0.2, 0.6)
        sc.bass_note(t, bn, 0.22, 1.0, slap=0.7)
    a.hit("kick", "kick", a.st(13, 12), 0.75)
    a.drum("snare", 13, "............oxXX")
    for step, name in ((12, "D2"), (13, "E2"), (14, "F#2")):
        sc.bass_note(a.st(13, step), name, g.steps(0.9), 0.85, slap=0.3)

    # ---- Bars 14-18: chorus 1 -----------------------------------------------------------------------------------
    sc.crash(T(14, 1))
    sc.brass_stab(T(14, 1), "G6", dur=0.2, vel=1.0)
    chorus_lines = {14: B_G6, 15: B_EM, 16: B_AM, 17: B_DM, 18: B_G13}
    for bar in range(14, 19):
        light = bar >= 17
        sc.groove_chorus(bar, (bar - 14) % 2, vel=0.85 if light else 1.0, shaker=not light)
        sc.bass_line(bar, chorus_lines[bar], vel=0.92 if light else 1.0)
        sc.ep_comp(bar, style="half", vel=0.55 if light else 0.6)
        sc.gtr_chops(bar, 0.5 if light else 0.6)
        sc.strings_pad(T(bar, 1), chord_at(bar), g.bar * 0.98, vel=0.26 if light else 0.32, attack=0.15)
    sc.lead_phrase(HOOK1)
    sc.snare_fill(18, (12, 13, 14, 15), 0.45, 0.85)

    # ---- Bars 19-20: handover tension, stop at [20,3] ---------------------------------------------------------------
    a.drum("kick", 19, "X...X...X...X...", vel=0.9)
    a.drum("rim", 19, "....x.......x...", vel=0.9)
    a.drum("hat", 19, "x.x.x.x.x.x.x.x.", vel=0.65)
    a.drum("kick", 20, "X...X...........", vel=0.9)
    a.drum("rim", 20, "....x...........", vel=0.9)
    a.drum("hat", 20, "x.x.x.x.........", vel=0.65)
    for bar, n_steps in ((19, 16), (20, 8)):
        sym = chord_at(bar)
        for k, s in enumerate(range(0, n_steps, 2)):
            nm = "E2" if k % 3 == 2 else "E1"
            sc.bass_note(a.st(bar, s), nm, g.steps(1.3), 0.85 + 0.1 * (nm == "E2"), slap=0.6 * (nm == "E2"))
            a.put("strings", inst.strings(N(V[sym]) + [N(V[sym])[-1] + 12], g.steps(1.0), 0.42, attack=0.008,
                                          release=0.06, cutoff=3600.0, seed=sc._s()), a.st(bar, s))
        for s in range(0, n_steps, 4):
            sc.ep_chord(a.st(bar, s), sym, g.steps(1.5), 0.5)

    # ---- Bars 21-22: VS ------------------------------------------------------------------------------------------------
    t = T(21, 1)
    sc.crash(t)
    a.hit("kick", "kick_boom", t, 1.0)
    a.put("timp", drums.timpani(33, 1.0, seed=sc._s()), t)
    sc.brass_stab(t, "Am", dur=0.6, vel=1.0, voicing=["A3", "E4", "A4", "C5"], up=False)
    a.put("brass", inst.brass(N(["A2", "E3"]), 0.6, 0.9, seed=sc._s()), t)
    sc.ep_chord(t, "Am", 0.5, 0.75)
    sc.bass_note(t, "A1", 0.5, 1.0, slap=0.6)
    for s, tn in zip(range(4, 16, 2), (45, 48, 45, 48, 45, 48)):
        sc.tom(a.st(21, s), tn, 0.95 if s in (8, 12) else 0.75)
    a.drum("kick", 21, "........X...X...")
    a.drum("snare", 21, "............X...", vel=0.85)
    a.drum("hat", 21, "....xoxoxoxoxoxo", vel=0.6)
    for s, nm in ((4, "A1"), (6, "A1"), (8, "A2"), (10, "A1"), (12, "A2"), (14, "A1")):
        sc.bass_note(a.st(21, s), nm, g.steps(1.5), 0.9, slap=0.7 if nm == "A2" else 0.2)
    a.drum("kick", 22, "X...X...........")
    for s, tn in zip(range(0, 8, 2), (45, 48, 45, 52)):
        sc.tom(a.st(22, s), tn, 0.8)
    a.drum("hat", 22, "xoxoxoxo........", vel=0.6)
    for s, nm in ((0, "A1"), (2, "A1"), (4, "A2"), (6, "A1")):
        sc.bass_note(a.st(22, s), nm, g.steps(1.5), 0.9, slap=0.7 if nm == "A2" else 0.2)
    t = T(22, 3)  # FIGHT!
    sc.crash(t)
    a.hit("kick", "kick", t, 1.0)
    a.hit("snare", "snare", t, 1.0)
    sc.brass_stab(t, "Am", dur=0.3, vel=1.0, voicing=["A3", "E4", "A4", "C5", "E5"], up=False)
    sc.bass_note(t, "A1", 0.3, 1.0, slap=0.7)
    sc.snare_fill(22, (12, 13, 14, 15), 0.6, 1.0)
    a.hit("kick", "kick", a.st(22, 12), 0.8)
    sc.bass_note(a.st(22, 12), "A2", g.steps(3.6), 0.85, slap=0.2)

    # ---- Bars 23-25: fight chorus -----------------------------------------------------------------------------------------
    sc.crash(T(23, 1))
    for bar, line in ((23, B_F), (24, B_G6)):
        sc.groove_fight(bar, bar - 23)
        sc.bass_line(bar, line)
        sc.ep_comp(bar)
        sc.gtr_chops(bar, 0.65)
        sc.strings_pad(T(bar, 1), chord_at(bar), g.bar * 0.98, vel=0.36, attack=0.12)
        sc.brass_stab(T(bar, 1), chord_at(bar), dur=0.16, vel=0.85)
    for s, tn in zip((12, 13, 14, 15), (52, 50, 48, 45)):
        sc.tom(a.st(24, s), tn, 0.85)
    a.hit("kick", "kick", T(25, 1), 1.0)
    a.drum("hat", 25, "xoxo............", vel=0.7)
    sc.bass_note(T(25, 1), "E1", g.steps(1.8), 1.0)
    sc.bass_note(a.st(25, 2), "E2", g.steps(1.5), 0.9, slap=0.8)
    sc.ep_chord(T(25, 1), "Em7", g.steps(3.5), 0.6)
    t = T(25, 2)
    a.hit("kick", "kick", t, 1.0)
    a.hit("snare", "snare", t, 1.0)
    sc.brass_stab(t, "Em7", dur=0.15, vel=0.95)
    sc.bass_note(t, "B1", 0.18, 1.0, slap=0.8)
    t = T(25, 3)  # K.O.
    sc.crash(t)
    a.hit("kick", "kick_boom", t, 1.0)
    a.hit("snare", "snare", t, 1.0)
    a.put("timp", drums.timpani(28, 1.0, seed=sc._s()), t)
    sc.brass_stab(t, "Em7", dur=0.55, vel=1.0)
    sc.ep_chord(t, "Em7", 0.8, 0.75)
    sc.bass_note(t, "E1", 0.8, 1.0, slap=0.8)
    a.put("bass", inst.sub(nn("E1"), 0.8, 0.5), t)
    sc.strings_pad(t, "Em7", g.beat * 1.9, vel=0.4, attack=0.03, release=0.1)
    sc.lead_phrase(HOOK2)
    # brass section carries the melody in the fight chorus: unison + diatonic third below, punchy legato notes
    for bar, step, ln, note, v in HOOK2:
        n0 = nn(note)
        dur = g.steps(ln) * (0.9 if ln < 4 else 0.97)
        a.put("brass", inst.brass([n0, diatonic(n0, -2)], dur, 0.82 * v, attack=0.008, scoop_cents=45.0,
                                  release=0.08, seed=sc._s()), a.st(bar, step))

    # ---- Bar 26: sad trombone over light percussion (stop-exempt) ----------------------------------------------------------
    tb = [(0.0, 0.33, nn("Ab3"), 0.9), (0.75, 0.33, nn("G3"), 0.88), (1.5, 0.33, nn("F#3"), 0.86), (2.25, 1.6, nn("F3"), 0.9)]
    tb = [(b * g.beat, d * (1.0 if k < 3 else g.beat), n, v) for k, (b, d, n, v) in enumerate(tb)]
    a.put("trombone", inst.trombone(tb, seed=sc._s()), T(26, 1))
    for s in range(0, 16, 2):
        a.hit("perc_x", "hat", a.st(26, s), 0.3 if s % 4 else 0.4)

    # ---- Bars 27-28: stop-time, bass climbing D-E-F-G-A-B-C ---------------------------------------------------------------
    hits = [((27, 1), "Dm9", "D2"), ((27, 3), "Em7", "E2"), ((27, 4), "Fmaj7", "F2"), ((28, 1), "G6", "G2"),
            ((28, 2), "Am9", "A2"), ((28, 3), "Bm7b5", "B2"), ((28, 4), "C6/9", "C3")]
    for k, ((bar, beat), sym, bn) in enumerate(hits):
        t = T(bar, beat)
        a.hit("kick", "kick", t, 1.0)
        a.hit("snare", "snare", t, 0.85 + 0.02 * k)
        a.hit("clap", "clap", t, 0.7)
        a.put("brass", inst.brass(N(ST_V[sym]) + [nn(bn) + 12], 0.14, 0.9 + 0.015 * k, attack=0.004, seed=sc._s()), t)
        sc.ep_chord(t, sym, 0.16, 0.6, voicing=[x for x in ST_V[sym]][:4])
        sc.bass_note(t, bn, 0.18, 1.0, slap=0.8)
    sc.crash(T(27, 1))
    a.hit("cym", "crash", T(28, 4), 0.55)
    for bar, ticks in ((27, (2, 4, 6, 10, 14)), (28, (2, 6, 10, 14))):
        for s in ticks:
            a.hit("hat", "hat", a.st(bar, s), 0.28)

    # ---- Bars 29-31: facts -------------------------------------------------------------------------------------------------
    sc.crash(T(29, 1))
    for bar, line in ((29, B_F), (30, B_G6)):
        sc.groove_chorus(bar, bar - 29, vel=0.92, shaker=False)
        sc.bass_line(bar, line)
        sc.ep_comp(bar)
        sc.gtr_chops(bar, 0.55)
        sc.strings_pad(T(bar, 1), chord_at(bar), g.bar * 0.98, vel=0.26, attack=0.15)
    a.drum("kick", 31, "X.....x.X...X...", vel=0.92)
    a.drum("snare", 31, "....X...........", vel=0.9)
    a.drum("hat", 31, "xoxoxoxo........", vel=0.65)
    sc.bass_line(31, [(0, "E1", 2, 1.0, "n"), (3, "E2", 1, 0.9, "p"), (6, "B1", 1, 0.8, "n"),
                      (8, "A1", 2, 0.95, "n"), (10, "B1", 2, 0.9, "n"), (12, "C2", 2, 0.9, "n"), (14, "C#2", 2, 0.9, "n")])
    sc.ep_comp(31)
    sc.gtr_chops(31, 0.5, steps=(2, 6), ghosts=False)
    for (bar, beat), sym in (((29, 1), "Fmaj7"), ((29, 3), "Fmaj7"), ((30, 1), "G6"), ((30, 3), "G6"), ((31, 1), "Em7")):
        sc.brass_stab(T(bar, beat), sym, dur=0.16, vel=0.92)
    for s, tn in zip(range(8, 14), (57, 57, 52, 52, 45, 45)):
        sc.tom(a.st(31, s), tn, 0.6 + 0.05 * (s - 8))
    a.drum("snare", 31, "..............xX")

    # ---- Bar 32: end jingle (one note per character of 来，看点好康的。) ---------------------------------------------------------
    a.drum("kick", 32, "X.......X.......")
    a.drum("snare", 32, "....X.......X...", vel=0.85)
    a.drum("hat", 32, "x.x.x.x.x.x.x.x.", vel=0.6)
    sc.bass_line(32, [(0, "D2", 3, 1.0, "n"), (3, "D3", 1, 0.9, "p"), (6, "C3", 1, 0.75, "n"), (7, "A2", 1, 0.8, "n"),
                      (8, "G1", 3, 1.0, "n"), (11, "G2", 1, 0.9, "p"), (12, "F2", 1, 0.8, "n"), (13, "E2", 1, 0.8, "n"),
                      (14, "D2", 1, 0.85, "n"), (15, "B1", 1, 0.85, "n")])
    sc.ep_chord(T(32, 1), "Dm9", g.steps(6), 0.55)
    sc.ep_chord(T(32, 3), "G13", g.steps(6), 0.55)
    sc.strings_pad(T(32, 1), "Dm9", g.beat * 1.95, vel=0.28, attack=0.1)
    sc.strings_pad(T(32, 3), "G13", g.beat * 1.95, vel=0.3, attack=0.1)
    sc.lead_phrase(JINGLE)

    # ---- Bars 33-34: final Cmaj9 ---------------------------------------------------------------------------------------------
    t = T(33, 1)
    sc.crash(t)
    a.hit("kick", "kick_boom", t, 1.0)
    a.put("timp", drums.timpani(36, 0.9, seed=sc._s()), t)
    a.put("brass", inst.brass(N(["C3", "G3", "E4", "G4", "B4", "D5"]), 1.0, 1.0, release=0.6, seed=sc._s()), t)
    sc.ep_chord(t, "Cmaj9", 2.6, 0.7)
    sc.strings_pad(t, "Cmaj9", 3.0, vel=0.5, attack=0.05, release=1.3)
    sc.bass_note(t, "C2", 1.6, 1.0, slap=0.5)
    a.put("bass", inst.sub(nn("C1"), 2.0, 0.6, release=0.8), t)
    for k, nt in enumerate(("C6", "E6", "G6", "B6", "D7", "E7")):
        a.put("glock", inst.glock(nn(nt), 0.55 - 0.05 * k, 1.6, seed=sc._s()), T(33, 1.5 + 0.25 * k))

    return {"stop_exempt": ["trombone", "perc_x"]}
