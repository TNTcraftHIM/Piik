"""Film F score — 出金了！ · GOLD! (9:16). Industrial electro-funk at 140 BPM in A minor, a future-bass drop in C.

Bar 1-2 terminal/host: sub pulse, ticking hats, glitch blips, a filtered pad. Bars 3-8: syncopated electro-funk groove
(kick/clap, 16th hats, rubber bass, offbeat house stabs), fuller with vocal chops for the party. Bar 9: the ten flips over
a thinned groove, then TRUE SILENCE (cue stop) for the dud; bar 10 a comic bounce under the laughter. Bars 11-12: the
mission groove (8th-note bass). Bars 13-14: the summon charge (filter opening, kick doubling, snare roll, breath).
Bars 15-16: the drop (supersaw on every beat, 808, chop hook). Bar 17 breakdown, 18-19 spec groove, 20-21 Cmaj9 + logo.
"""
from __future__ import annotations

from engine.core import nn
from engine import inst_bc as ib
from engine import voice
from engine.arrange import Arranger

V = {  # chord voicings (pads / stabs / supersaw)
    "Am9": ["C4", "E4", "G4", "B4"], "Fmaj9": ["A3", "C4", "E4", "G4"], "Am7": ["A3", "C4", "E4", "G4"],
    "Fmaj7": ["F3", "A3", "C4", "E4"], "Dm7": ["F3", "A3", "C4", "D4"], "E7sus4": ["E3", "A3", "B3", "D4"],
    "E7": ["E3", "G#3", "B3", "D4"], "G6": ["G3", "B3", "D4", "E4"], "Em7": ["E3", "G3", "B3", "D4"],
    "G": ["G3", "B3", "D4", "G4"], "Am": ["A3", "C4", "E4", "A4"], "G/B": ["B2", "D3", "G3", "B3"],
    "C": ["C4", "E4", "G4", "C5"], "Cmaj9": ["C3", "G3", "D4", "E4", "B4"],
}
ROOT = {"Am9": "A1", "Fmaj9": "F1", "Am7": "A1", "Fmaj7": "F1", "Dm7": "D2", "E7sus4": "E1", "E7": "E1", "G6": "G1",
        "Em7": "E1", "G": "G1", "Am": "A1", "G/B": "B1", "C": "C2", "Cmaj9": "C2"}
CHORDS = {1: "Am9", 2: "Fmaj9", 3: "Am7", 4: "Fmaj7", 5: "Dm7", 6: ("E7sus4", "E7"), 7: ("Fmaj7", "G6"), 8: ("Em7", "Am7"),
          9: "Dm7", 10: ("Fmaj7", "E7"), 11: "Am7", 12: ("Fmaj7", "G"), 13: ("Fmaj7", "G"), 14: ("Am", "G/B"),
          15: ("Fmaj9", "G"), 16: ("Em7", "Am7"), 17: ("Fmaj9", "G6"), 18: ("Am7", "Fmaj7"), 19: ("C", "G"),
          20: "Cmaj9", 21: "Cmaj9"}
# party chop melody (bar, step, len, note, vowel) and the drop hook
PARTY = [(7, 0, 2, "A4", "a"), (7, 3, 1, "C5", "i"), (7, 4, 2, "E5", "a"), (7, 8, 2, "D5", "o"), (7, 11, 1, "B4", "i"),
         (7, 12, 2, "G4", "a"), (8, 0, 2, "G4", "a"), (8, 3, 1, "B4", "i"), (8, 4, 3, "E5", "ai")]
HOOK = [(15, 0, 2, "C5", "a"), (15, 2, 2, "E5", "i"), (15, 4, 3, "A5", "a"), (15, 7, 1, "G5", "o"),
        (15, 8, 2, "D5", "a"), (15, 10, 2, "G5", "i"), (15, 12, 3, "B5", "ai"), (15, 15, 1, "A5", "o"),
        (16, 0, 2, "G5", "a"), (16, 2, 2, "E5", "i"), (16, 4, 3, "B4", "a"), (16, 7, 1, "D5", "o"),
        (16, 8, 2, "E5", "a"), (16, 10, 2, "C5", "i"), (16, 12, 4, "A4", "ao")]
INTRO = [(2, 0, "E5"), (2, 3, "D5"), (2, 6, "C5"), (2, 10, "A4"), (2, 13, "G4")]


def chord_at(bar, beat=1.0):
    c = CHORDS.get(bar)
    if isinstance(c, tuple):
        return c[0] if beat < 3 else c[1]
    return c


def N(names, up=0):
    return [nn(x) + up for x in names]


class Score:
    def __init__(self, a: Arranger):
        self.a, self.g = a, a.g
        self.seed = 500

    def _s(self):
        self.seed += 1
        return self.seed

    # ------------------------------------------------------------------ parts
    def stab(self, t, sym, vel=0.6, dur=0.12, up=12, bright=1.0):
        self.a.put("stab", ib.house_stab(N(V[sym], up), dur, vel, bright=bright, seed=self._s()), t)

    def bass(self, t, note, dur, vel=0.85, glide_from=None):
        self.a.put("bass", ib.rubber_bass(note, dur, vel, glide_from=glide_from, seed=self._s()), t)

    def b808(self, t, sym, dur, vel=0.9, glide_from=None):
        self.a.put("bass808", ib.sub808(nn(ROOT[sym]), dur, vel, glide_from=glide_from), t)

    def saw(self, t, sym, dur, vel=0.7, bend=0.0, swell=0.0, release=0.2, cutoff=6500.0, up=0, track="saw"):
        self.a.put(track, ib.supersaw(N(V[sym], up), dur, vel, bend_from=bend, swell=swell, release=release, cutoff=cutoff,
                                      seed=self._s()), t)

    def pad(self, t, sym, dur, vel=0.4, cutoff=2400.0, attack=0.4):
        self.a.put("pad", ib.soft_pad(N(V[sym]), dur, vel, attack=attack, release=0.8, cutoff=cutoff, seed=self._s()), t)

    def crash(self, t, vel=0.7):
        self.a.hit("cym", "crash", t, vel, variants=3)

    def funk_bar(self, bar, vel=1.0, kick="X..x..X...X..x..", clap="....X.......X...", hats=True, ohat=True, skip_kick=()):
        a = self.a
        a.drum("kick", bar, kick, vel=vel, skip=skip_kick)
        a.drum("clap", bar, clap, vel=0.9 * vel)
        a.drum("snare", bar, clap, kind="snare", vel=0.45 * vel)
        if hats:
            a.drum("hat", bar, "xhxhxhxhxhxhxhxh", vel=0.62 * vel, human_ms=1.5)
        if ohat:
            a.drum("ohat", bar, "..x...x...x...x.", vel=0.45 * vel, human_ms=1.0)

    def funk_bass(self, bar, sym, vel=0.85, beats=(1, 2, 3, 4)):
        """Syncopated root/octave line under the groove; `beats` limits it to part of the bar (two-chord bars)."""
        a, st = self.a, self.g.steps(1)
        r = nn(ROOT[sym]) + 12
        for step, iv, ln in ((0, 0, 2), (3, 12, 1), (6, 0, 2), (10, 7, 1), (11, 12, 1), (14, 0, 2)):
            beat = 1 + step // 4
            if beat in beats:
                self.bass(a.st(bar, step), r + iv, st * ln * 0.9, vel * (1.0 if step == 0 else 0.8))

    def offbeat_stabs(self, bar, vel=0.55, skip=()):
        for step in (2, 6, 10, 14):
            if step in skip:
                continue
            self.stab(self.a.st(bar, step), chord_at(bar, 1 + step / 4), vel)

    def pump(self, bars):
        for bar in bars:
            for beat in (1, 2, 3, 4):
                self.a.sc_extra.append(self.g.t(bar, beat))


def compose(a: Arranger) -> dict:
    sc = Score(a)
    g = a.g
    T = g.t
    st = g.steps(1)  # one 16th = 0.107 s

    # ---- bar 1: summon terminal ---------------------------------------------------------------------------------
    a.hit("kick", "kick_boom", T(1, 1), 0.9)
    sc.crash(T(1, 1), 0.45)
    sc.pad(T(1, 1), "Am9", g.bar * 1.9, 0.5, cutoff=1500.0, attack=0.3)
    sc.b808(T(1, 1), "Am9", g.bar * 0.95, 0.7)
    a.drum("hat", 1, "x.x.x.x.x.x.x.x.", vel=0.45, human_ms=1.0)
    for k, step in enumerate((5, 7, 9, 15)):                         # glitch blips (high, short)
        a.put("glitch", ib.saw_pluck(nn("E6") + (k * 5) % 12, 0.05, 0.5, bright=1.4, seed=sc._s()), a.st(1, step))
    t = T(1, 3)                                                      # caption slam
    a.hit("clap", "clap", t, 0.9)
    a.hit("kick", "kick", t, 0.8)
    sc.stab(t, "Am9", 0.8, dur=0.2)

    # ---- bar 2: host's lines over a held pad + pluck motif ---------------------------------------------------------
    sc.b808(T(2, 1), "Fmaj9", g.bar * 0.9, 0.6)
    a.drum("hat", 2, "x.x.x.x.x.x.x.x.", vel=0.4, human_ms=1.0)
    a.drum("shaker", 2, "gogogogogogogogo", vel=0.5, human_ms=2, pan=0.3)
    for bar, step, note in INTRO:
        a.put("pluck", ib.saw_pluck(nn(note), 0.22, 0.5, bright=0.7, seed=sc._s()), a.st(bar, step))
    for k in range(4):                                               # 16th pickup into the groove
        a.hit("snare", "snare_ghost", a.st(2, 12 + k), 0.25 + 0.12 * k)

    # ---- bars 3-6: electro-funk groove A (share / invite) -----------------------------------------------------------
    sc.pump(range(3, 7))
    sc.crash(T(3, 1), 0.7)
    for bar in (3, 4, 5, 6):
        sym = chord_at(bar)
        sc.funk_bar(bar, vel=0.95 if bar != 6 else 0.85)
        if bar == 6:
            sc.funk_bass(6, "E7sus4", 0.8, beats=(1, 2))
            sc.funk_bass(6, "E7", 0.85, beats=(3, 4))
            sc.offbeat_stabs(6, 0.45, skip=(2, 6))                   # the three taps own the first half of bar 6
        else:
            sc.funk_bass(bar, sym, 0.85)
            sc.offbeat_stabs(bar, 0.55)
        sc.pad(T(bar, 1), sym if bar != 6 else "E7sus4", g.bar * 0.95, 0.28, cutoff=2000.0)
    t = T(4, 1)                                                      # LIVE
    sc.crash(t, 0.8)
    sc.stab(t, "Fmaj7", 0.85, dur=0.25)
    t = T(4, 2)                                                      # feature 01
    sc.stab(t, "Fmaj7", 0.8, dur=0.18, up=24, bright=1.2)
    t = T(6, 3)                                                      # stamp
    sc.crash(t, 0.75)
    a.hit("kick", "kick", t, 1.0)
    sc.stab(t, "E7", 0.9, dur=0.25)

    # ---- bars 7-8: party groove B (royal road), vocal chops ------------------------------------------------------------
    sc.pump(range(7, 9))
    sc.crash(T(7, 1), 0.75)
    for bar in (7, 8):
        sc.funk_bar(bar, vel=1.0)
        a.drum("shaker", bar, "gogogogogogogogo", vel=0.6, human_ms=2, pan=0.3)
        for half, beats in ((0, (1, 2)), (1, (3, 4))):
            sym = chord_at(bar, 1 + 2 * half)
            sc.funk_bass(bar, sym, 0.85, beats=beats)
            sc.pad(T(bar, 1 + 2 * half), sym, g.beat * 1.95, 0.3, cutoff=2600.0)
        sc.offbeat_stabs(bar, 0.5)
    for bar, step, ln, note, vow in PARTY:
        tt = a.st(bar, step)
        d = ln * st * 0.9
        a.put("chop", voice.chop(nn(note), d, vow, who="yuan", vel=0.75, glide=-1.2 if ln >= 2 else 0.0, seed=sc._s()), tt)
        a.put("pluck", ib.saw_pluck(nn(note) + 12, d, 0.4, seed=sc._s()), tt)
    t = T(8, 3)                                                      # the first ten-pull click
    sc.crash(t, 0.6)
    sc.stab(t, "Am7", 0.85, dur=0.2)
    for k, nt in enumerate(("A4", "C5", "E5", "G5")):                # deal run up to the flips
        a.put("pluck", ib.saw_pluck(nn(nt) + 12, 0.08, 0.45 + 0.08 * k, seed=sc._s()), a.st(8, 12 + k))

    # ---- bar 9: flips over a thinned groove; stop at [9,3.5] (cue) -------------------------------------------------------
    a.drum("kick", 9, "X.......X.......", vel=0.85)
    a.drum("hat", 9, "x.x.x.x.x.x.x.x.", vel=0.5)
    sc.bass(T(9, 1), nn("D2") + 12, g.beat * 2.4, 0.75)
    sc.pad(T(9, 1), "Dm7", g.beat * 2.4, 0.3, cutoff=1800.0)
    # ---- bar 10: comic bounce under the laughter ------------------------------------------------------------------------
    sc.pump([10])
    a.drum("kick", 10, "X...X...X...X...", vel=0.9)
    a.drum("clap", 10, "....X.......X...", vel=0.85)
    a.drum("hat", 10, "..x...x...x...x.", kind="ohat", vel=0.5)
    for k, (step, nt) in enumerate(((0, "F2"), (2, "F3"), (4, "C3"), (6, "F3"), (8, "E2"), (10, "E3"), (12, "B2"), (14, "G#2"))):
        sc.bass(a.st(10, step), nn(nt) + 12, st * 1.4, 0.8)
    for step in (2, 6):
        sc.stab(a.st(10, step), "Fmaj7", 0.5, dur=0.08)
    for step in (10, 14):
        sc.stab(a.st(10, step), "E7", 0.5, dur=0.08)

    # ---- bars 11-12: mission groove (remote control) ------------------------------------------------------------------
    sc.pump(range(11, 13))
    sc.crash(T(11, 1), 0.8)
    for bar in (11, 12):
        a.drum("kick", bar, "X...X...X...X...", vel=1.0)
        a.drum("clap", bar, "....X.......X...", vel=0.9)
        a.drum("hat", bar, "xhxhxhxhxhxhxhxh", vel=0.6, human_ms=1.5)
        a.drum("ohat", bar, "..x...x...x...x.", vel=0.4)
        for half in (0, 1):
            sym = chord_at(bar, 1 + 2 * half)
            r = nn(ROOT[sym]) + 12
            for k in range(4):                                           # driving 8ths, octave on the offbeat
                sc.bass(a.st(bar, 8 * half + 2 * k), r + (12 if k % 2 else 0), st * 1.6, 0.8)
            sc.pad(T(bar, 1 + 2 * half), sym, g.beat * 1.95, 0.3, cutoff=3000.0)
        sc.offbeat_stabs(bar, 0.5)
    t = T(12, 1)                                                     # ALLOW
    sc.crash(t, 0.75)
    sc.stab(t, "Fmaj7", 0.9, dur=0.25, up=24, bright=1.2)

    # ---- bars 13-14: the summon charge ------------------------------------------------------------------------------------
    sc.pump(range(13, 15))
    sc.crash(T(13, 1), 0.8)
    a.drum("kick", 13, "X...X...X...X...", vel=0.95)
    a.drum("kick", 14, "X.X.X.X.X.X.X...", vel=1.0)
    a.drum("hat", 13, "x.x.x.x.x.x.x.x.", vel=0.55)
    a.drum("hat", 14, "xxxxxxxxxxxxxx..", vel=0.6)
    for k in range(14):                                              # snare roll building through bar 14
        a.hit("snare", "snare", a.st(14, k), 0.22 + 0.055 * k)
    for k, (bar, beat) in enumerate(((13, 1), (13, 3), (14, 1), (14, 3))):
        sym = chord_at(bar, beat)
        sc.saw(T(bar, beat), sym, g.beat * 1.95, vel=0.32 + 0.08 * k, swell=0.25, release=0.05, cutoff=1400.0 + 1500.0 * k)
        sc.b808(T(bar, beat), sym, g.beat * 1.9, 0.75 + 0.05 * k)
    for k, nt in enumerate(("E5", "G5", "A5", "B5", "C6", "D6", "E6")):  # pluck climb in the last half bar
        a.put("pluck", ib.saw_pluck(nn(nt), 0.07, 0.35 + 0.08 * k, bright=1.2, seed=sc._s()), a.st(14, 8 + k))

    # ---- bars 15-16: DROP ------------------------------------------------------------------------------------------------
    sc.pump(range(15, 17))
    sc.crash(T(15, 1), 1.0)
    a.hit("kick", "kick_boom", T(15, 1), 1.0)
    for bar in (15, 16):
        a.drum("kick", bar, "X.....x...X.....", vel=1.0)
        a.drum("snare", bar, "........X.......", vel=0.9)
        a.drum("clap", bar, "........X.......", vel=0.95)
        a.drum("hat", bar, "x.x.x.x.x.x.xxxx", vel=0.7, human_ms=1.5)
        for beat in (1, 2, 3, 4):
            sym = chord_at(bar, beat)
            first = beat in (1, 3)
            sc.saw(T(bar, beat), sym, g.beat * 0.78, vel=1.0 if first else 0.85, bend=-1.0 if first else 0.0,
                   release=0.1, cutoff=9500.0, track="sawd")
            if first:
                sc.saw(T(bar, beat), sym, g.beat * 1.9, vel=0.45, swell=0.04, release=0.08, cutoff=5000.0, up=12, track="sawd")
                sc.b808(T(bar, beat), sym, g.beat * 1.9, 1.0)
            sc.saw(T(bar, beat) + g.beat / 2, sym, g.beat * 0.3, vel=0.42, release=0.06, cutoff=8000.0, track="sawd")
        for beat in (2, 4):
            a.hit("kick", "kick", T(bar, beat), 0.55)
    for bar, step, ln, note, vow in HOOK:
        tt = a.st(bar, step)
        d = ln * st * 0.92
        a.put("chop", voice.chop(nn(note), d, vow, who="dian", vel=0.85, glide=-1.5 if ln >= 2 else 0.0, seed=sc._s()), tt)
        a.put("pluck", ib.saw_pluck(nn(note) + 12, d, 0.45, seed=sc._s()), tt)
        a.put("musicbox", ib.musicbox(nn(note) + 12, 0.3, 0.6, seed=sc._s()), tt)

    # ---- bar 17: payoff breakdown --------------------------------------------------------------------------------------------
    for half in (0, 1):
        sym = chord_at(17, 1 + 2 * half)
        sc.pad(T(17, 1 + 2 * half), sym, g.beat * 1.95, 0.42, cutoff=3000.0, attack=0.08)
        for k, n in enumerate(N(V[sym], 12)):
            a.put("pluck", ib.saw_pluck(n, 0.2, 0.32, bright=0.6, seed=sc._s()), T(17, 1 + 2 * half) + 0.008 * k)
    a.drum("hat", 17, "..x...x...x...x.", vel=0.45)
    for k, nt in enumerate(("C6", "E6", "G6", "B6")):
        a.put("musicbox", ib.musicbox(nn(nt), 0.42, 0.8, seed=sc._s()), T(17, 3) + k * st)

    # ---- bars 18-19: spec groove, a stab per row --------------------------------------------------------------------------
    sc.pump(range(18, 20))
    sc.crash(T(18, 1), 0.7)
    for bar in (18, 19):
        a.drum("kick", bar, "X...X...X...X...", vel=0.95)
        a.drum("clap", bar, "....X.......X...", vel=0.85)
        a.drum("hat", bar, "xhxhxhxhxhxhxhxh", vel=0.55, human_ms=1.5)
        for half in (0, 1):
            sym = chord_at(bar, 1 + 2 * half)
            sc.funk_bass(bar, sym, 0.8, beats=(1, 2) if half == 0 else (3, 4))
            sc.pad(T(bar, 1 + 2 * half), sym, g.beat * 1.95, 0.3, cutoff=2800.0)
    for k, (bar, beat) in enumerate(((18, 2), (18, 2.5), (18, 3), (18, 3.5), (18, 4), (18, 4.5), (19, 1))):  # one per row
        sc.stab(T(bar, beat), chord_at(bar, beat), 0.62 + 0.04 * k, dur=0.1, up=12 + (12 if k >= 4 else 0))

    # ---- bars 20-21: Cmaj9 + the sonic logo (piik_chirp is an SFX cue at [20,1]) ----------------------------------------------
    t = T(20, 1)
    sc.crash(t, 0.85)
    a.hit("kick", "kick_boom", t, 1.0)
    sc.saw(t, "Cmaj9", g.bar * 1.2, vel=0.8, bend=-1.0, release=1.4, cutoff=7000.0)
    sc.b808(t, "Cmaj9", g.bar * 1.2, 0.95)
    sc.pad(t, "Cmaj9", g.bar * 1.8, 0.4, cutoff=3200.0, attack=0.05)
    for k, nt in enumerate(("C6", "E6", "G6", "B6", "D7")):
        a.put("musicbox", ib.musicbox(nn(nt), 0.42 - 0.05 * k, 1.4, seed=sc._s()), t + 0.3 + k * st)
    return {}
