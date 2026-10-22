"""Film E score — 打倒无聊 · DEFEAT BOREDOM. Original chiptune, 150 BPM, A minor battle → C major party/victory.

Channels: p1 (lead pulse), p2 (harmony / arps pulse), tri (stepped triangle bass), noise drums (kick/snare/hat/crash).
Melodies are written as (step, note, length-in-16ths) per bar on a straight 16th grid.
"""
from __future__ import annotations

from engine.core import nn
from engine.arrange import Arranger
import chip as C

CHORDS = {1: "Am7", 2: "Fmaj7", 3: "Dm7", 4: "E7", 5: "Am", 6: "F", 7: "G", 8: "E", 9: "F", 10: "G", 11: "C",
          12: "C / E", 13: "G", 14: "G7", 15: "C", 16: "G", 17: "Am", 18: "F", 19: "C", 20: "G", 21: "F", 22: "E7",
          23: "Am", 24: "E7", 25: "C", 26: "F", 27: "G", 28: "C", 29: "Fmaj7", 30: "Em7", 31: "Dm7", 32: "G",
          33: "C", 34: "C", 35: "C", 36: "C"}
TONES = {"Am7": ["A4", "C5", "E5", "G5"], "Fmaj7": ["F4", "A4", "C5", "E5"], "Dm7": ["D4", "F4", "A4", "C5"],
         "E7": ["E4", "G#4", "B4", "D5"], "Am": ["A4", "C5", "E5"], "F": ["F4", "A4", "C5"], "G": ["G4", "B4", "D5"],
         "E": ["E4", "G#4", "B4"], "C": ["C5", "E5", "G5"], "G7": ["G4", "B4", "D5", "F5"], "Em7": ["E4", "G4", "B4", "D5"]}
ROOT = {"Am7": "A2", "Fmaj7": "F2", "Dm7": "D2", "E7": "E2", "Am": "A2", "F": "F2", "G": "G2", "E": "E2", "C": "C3",
        "G7": "G2", "Em7": "E2"}


def m(x):
    return nn(x) if isinstance(x, str) else x


class Score:
    def __init__(self, a: Arranger):
        self.a = a
        self.g = a.g

    def t(self, bar, step):
        return self.g.step_t(bar, step)

    def p(self, track, bar, step, note, steps, duty=0.25, vol=0.34, pan=0.0, **kw):
        d = self.g.steps(steps) * 0.94
        self.a.put(track, C.pulse_note(m(note), d, duty, vol, **kw), self.t(bar, step), pan=pan)

    def line(self, track, bar, notes, duty=0.5, vol=0.34, pan=-0.12, **kw):
        for step, note, ln in notes:
            extra = dict(kw)
            if ln >= 4 and "vib" not in extra:
                extra["vib"] = 16.0
            self.p(track, bar, step, note, ln, duty, vol, pan, **extra)

    def tri(self, bar, step, note, steps, vol=0.85, **kw):
        self.a.put("tri", C.tri_note(m(note), self.g.steps(steps) * 0.9, vol, **kw), self.t(bar, step))

    def bass8(self, bar, chord, pattern=(0, 0, 12, 0, 7, 0, 12, 0), vol=0.85):
        r = m(ROOT[chord])
        for k, off in enumerate(pattern):
            self.tri(bar, k * 2, r + off, 2, vol)

    def drums(self, bar, k="X.....X.X.......", s="....X.......X...", h="x.x.x.x.x.x.x.x.", vel=1.0, crash=False):
        for i, ch in enumerate(k):
            if ch in "Xx":
                self.a.put("kick", C.kick(vel * (1.0 if ch == "X" else 0.7)), self.t(bar, i))
        for i, ch in enumerate(s):
            if ch in "Xxo":
                self.a.put("snare", C.snare(vel * {"X": 1.0, "x": 0.7, "o": 0.4}[ch]), self.t(bar, i))
        for i, ch in enumerate(h):
            if ch in "xXo":
                self.a.put("hat", C.hat(vel * (0.8 if ch == "X" else 0.55), open_=ch == "o"), self.t(bar, i), pan=0.18)
        if crash:
            self.crash(bar, 0, vel)

    def crash(self, bar, step, vel=0.9):
        self.a.put("crash", C.crash(vel), self.t(bar, step), pan=-0.1)

    def stab(self, bar, step, notes, steps=2, vol=0.2, duty=0.25):
        for n in notes:
            self.p("p2", bar, step, n, steps, duty, vol, 0.2, d=0.06, s=0.5)

    def arp16(self, bar, chord, start=0, end=16, vol=0.18, duty=0.125, octave=12, updown=True):
        tones = [m(x) + octave for x in TONES[chord]]
        seq = tones + tones[-2:0:-1] if updown else tones
        for i, st in enumerate(range(start, end)):
            self.p("p2", bar, st, seq[i % len(seq)], 1, duty, vol, 0.22, d=0.04, s=0.5, r=0.01)


def compose(a: Arranger) -> dict:
    sc = Score(a)

    # ---- bars 1-3: the room — sleepy arps, triangle roots, a two-note sigh motif ----------------------------------
    arps = {1: ["A4", "C5", "E5", "G5", "E5", "C5", "A4", "E4"], 2: ["F4", "A4", "C5", "E5", "C5", "A4", "F4", "C4"],
            3: ["D4", "F4", "A4", "C5", "A4", "F4", "D4", "A3"]}
    for bar, notes in arps.items():
        for k, n in enumerate(notes):
            sc.p("p2", bar, k * 2, n, 2, 0.125, 0.16 + 0.02 * (k % 2 == 0), 0.2, d=0.12, s=0.35, r=0.05)
        sc.tri(bar, 0, ROOT[CHORDS[bar]], 16, 0.32)
    sc.line("p1", 1, [(8, "E5", 4), (12, "C5", 4)], duty=0.25, vol=0.26)
    sc.line("p1", 2, [(8, "D5", 3), (11, "C5", 1), (12, "A4", 4)], duty=0.25, vol=0.26)
    sc.line("p1", 3, [(4, "C5", 2), (6, "B4", 2), (8, "A4", 6)], duty=0.25, vol=0.26)

    # ---- bar 4: battle transition — snare roll + tom fill, gap at [4,4.5] -------------------------------------------
    for i in range(10):
        a.put("snare", C.snare(0.25 + 0.07 * i), sc.t(4, i))
    for i, nt in zip(range(10, 14), (62, 57, 52, 47)):
        a.put("tom", C.tom(nt, 0.9), sc.t(4, i))
    sc.tri(4, 0, "E2", 12, 0.7)

    # ---- bars 5-8: battle theme A --------------------------------------------------------------------------------------
    riff = {
        5: [(0, "E5", 1), (2, "E5", 1), (3, "D5", 1), (4, "E5", 2), (6, "A5", 2), (8, "G5", 1), (9, "E5", 1), (10, "D5", 1), (11, "C5", 1), (12, "D5", 2), (14, "E5", 2)],
        6: [(0, "F5", 1), (2, "F5", 1), (3, "E5", 1), (4, "F5", 2), (6, "C6", 2), (8, "A5", 1), (9, "G5", 1), (10, "F5", 1), (11, "E5", 1), (12, "F5", 2), (14, "A5", 2)],
        7: [(0, "G5", 1), (2, "G5", 1), (3, "F5", 1), (4, "G5", 2), (6, "D6", 2), (8, "B5", 1), (9, "A5", 1), (10, "G5", 1), (11, "F5", 1), (12, "G5", 2), (14, "B5", 2)],
    }
    for bar in (5, 6, 7, 8):
        chord = CHORDS[bar]
        sc.drums(bar, k="X.....X.X.....x." if bar < 8 else "X.......X.X.X...", s="....X.......X..." if bar < 8 else "....X.......XxXx",
                 h="x.x.x.x.x.x.x.o.", crash=bar == 5)
        sc.bass8(bar, chord)
        for st in (2, 6, 10, 14):
            sc.stab(bar, st, [m(x) for x in TONES[chord][1:3]], 1, 0.15)
        if bar in riff:
            sc.line("p1", bar, riff[bar])
    sc.stab(7, 4, ["G5", "B5", "D6"], 2, 0.24, 0.5)                  # [7,2] the tiny hit
    a.put("p1", C.pulse_note(nn("E6"), sc.g.steps(8) * 0.95, 0.5, 0.34, a=0.002, d=0.2, s=0.8, r=0.05, bend_to=nn("E5"), vib=50, vib_rate=5.0), sc.t(8, 0), pan=-0.12)  # the yawn droop
    sc.line("p1", 8, [(10, "D6", 1), (11, "C6", 1), (12, "B5", 1), (13, "G#5", 1), (14, "E5", 2)])

    # ---- bars 9-11: PIIK — hopeful motif over bright arps --------------------------------------------------------------
    for bar in (9, 10, 11):
        chord = CHORDS[bar]
        sc.drums(bar, k="X.......X.......", s="............X..." if bar == 11 else "................", h="o.x.o.x.o.x.o.x.", vel=0.7)
        r = m(ROOT[chord])
        for k, off in enumerate((0, 7, 12, 7)):
            sc.tri(bar, k * 4, r + off, 4, 0.75)
        sc.arp16(bar, chord, vol=0.13)
    sc.line("p1", 9, [(0, "C5", 2), (2, "D5", 2), (4, "F5", 4), (8, "A5", 2), (10, "G5", 2), (12, "F5", 4)], duty=0.25)
    sc.line("p1", 10, [(0, "G5", 2), (2, "A5", 2), (4, "B5", 4), (8, "C6", 4), (12, "B5", 2), (14, "G5", 2)], duty=0.25)
    sc.stab(10, 8, ["C6", "E6", "G6"], 3, 0.22)                       # [10,3] LIVE
    sc.crash(10, 8, 0.6)
    sc.line("p1", 11, [(0, "C6", 4), (4, "G5", 2), (6, "E5", 2), (8, "G5", 2), (10, "C6", 2), (12, "E6", 4)], duty=0.25)

    # ---- bars 12-14: party joins (fanfares are SFX) → build -----------------------------------------------------------
    for bar, steps_chords in ((12, ((0, "C", 8), (8, "E", 8))), (13, ((0, "G", 16),)), (14, ((0, "G7", 16),))):
        for st, ch, ln in steps_chords:
            for n in TONES[ch]:
                sc.p("p2", bar, st, m(n), ln, 0.5, 0.11, 0.2, a=0.02, d=0.3, s=0.7, r=0.08)
            sc.tri(bar, st, ROOT[ch], ln, 0.75)
    for bar, st in ((12, 0), (12, 8), (13, 0)):
        sc.crash(bar, st, 0.55)
        a.put("kick", C.kick(0.9), sc.t(bar, st))
    for i in range(8, 16):
        a.put("snare", C.snare(0.25 + 0.04 * (i - 8)), sc.t(13, i))
    for i in range(16):
        a.put("snare", C.snare(0.45 + 0.035 * i), sc.t(14, i))
    for i in range(0, 8):
        sc.p("p1", 14, i, "G5" if i % 2 == 0 else "A5", 1, 0.25, 0.18 + 0.02 * i, -0.12, d=0.05, s=0.6)
    sc.line("p1", 14, [(8 + k, n, 1) for k, n in enumerate(("G5", "A5", "B5", "C6", "D6", "E6", "F6", "G6"))], duty=0.5, vol=0.3)

    # ---- bars 15-24: battle theme B -------------------------------------------------------------------------------------
    melody = {
        15: [(0, "G5", 4), (4, "C6", 4), (8, "E6", 2), (10, "D6", 2), (12, "C6", 4)],
        16: [(0, "B5", 4), (4, "D6", 4), (8, "G6", 2), (10, "F6", 2), (12, "D6", 4)],
        17: [(0, "A5", 2), (2, "C6", 2), (4, "E6", 4)],
        18: [(8, "G6", 4), (12, "E6", 4)],
        19: [(0, "E6", 4), (4, "G6", 4), (8, "C7", 4)],
        23: [],
    }
    for bar in range(15, 25):
        chord = CHORDS[bar]
        if bar == 20:
            # [20,1]-[20,3] is a full stop (gate); tension restarts on beat 3
            sc.drums(bar, k="........X.X.X.X.", s="................", h="........x.x.x.x.", vel=0.8)
            for st in range(8, 16):
                sc.tri(bar, st, "G2", 1, 0.8)
            continue
        if bar == 21:
            sc.drums(bar, k="X.......X.......", s="....x.......x...", h="x.x.x.x.x.x.x.x.", vel=0.75)
            sc.bass8(bar, chord, vol=0.75)
            for st, n in ((0, "F4"), (4, "E4"), (8, "F4"), (12, "D4")):
                sc.p("p2", bar, st, n, 3, 0.5, 0.2, 0.15, d=0.1, s=0.5)
            continue
        if bar == 22:
            sc.drums(bar, k="X...X...X...X...", s="..x...x...x.x.xx", h="xxxxxxxxxxxxxxxx", vel=0.85)
            sc.bass8(bar, chord, vol=0.85)
            for st in range(16):
                sc.p("p1", bar, st, "B5" if st % 2 == 0 else "C6", 1, 0.25, 0.16 + 0.012 * st, -0.12, d=0.04, s=0.6)
            continue
        if bar == 23:
            sc.crash(bar, 0, 0.9)
            sc.stab(bar, 0, ["A5", "C6", "E6"], 4, 0.24, 0.5)
            sc.tri(bar, 0, "A2", 4, 0.9)
            for i in range(4, 16):
                a.put("snare", C.snare(0.35 + 0.05 * (i - 4)), sc.t(bar, i))
                sc.p("p1", bar, i, nn("A4") + (i - 4), 1, 0.5, 0.2 + 0.012 * i, -0.12, d=0.04, s=0.7)
                sc.tri(bar, i, nn("A2") + (i - 4) // 2, 1, 0.8)
            continue
        if bar == 24:
            for st in (0, 4, 8, 12):
                sc.crash(bar, st, 0.75)
                a.put("kick", C.kick(1.0), sc.t(bar, st))
                for n in ("E5", "G#5", "B5", "D6"):
                    sc.p("p1" if n == "D6" else "p2", bar, st, n, 2, 0.5, 0.2, 0.0, d=0.1, s=0.5)
                sc.tri(bar, st, "E2", 2, 0.95)
            for st, nt in ((2, 64), (3, 59), (6, 64), (7, 59), (10, 64), (11, 59), (14, 59), (15, 55)):
                a.put("tom", C.tom(nt, 0.7), sc.t(bar, st))
            continue
        sc.drums(bar, k="X.....X.X.....X." if bar % 2 else "X.....X.X.......", s="....X.......X...", h="xxxxxxxxxxxxxxxx", vel=0.9, crash=bar in (15, 19))
        sc.bass8(bar, chord)
        if bar in melody:
            sc.line("p1", bar, melody[bar])
        if bar == 17:
            sc.arp16(bar, chord, start=8, end=16, vol=0.2)
        elif bar == 18:
            sc.arp16(bar, chord, start=0, end=8, vol=0.2)
            sc.stab(bar, 8, ["C6", "E6", "G6"], 3, 0.26, 0.5)       # [18,3] super effective
            sc.crash(bar, 8, 0.8)
        else:
            for st in (2, 6, 10, 14):
                sc.stab(bar, st, [m(x) + 12 for x in TONES[chord][1:3]], 1, 0.12)
        if bar == 19:
            sc.stab(bar, 12, ["C5", "E5", "G5", "C6"], 2, 0.22, 0.5)  # [19,4] splat hit
            sc.crash(bar, 12, 0.7)

    # ---- bars 25-28: victory fanfare (original) --------------------------------------------------------------------------
    sc.crash(25, 0, 1.0)
    for n in ("G5", "C6", "E6"):
        sc.p("p2", 25, 0, n, 8, 0.5, 0.18, 0.1, d=0.5, s=0.6, r=0.1)
    sc.tri(25, 0, "C2", 8, 0.9)
    fan = {25: [(8, "G5", 1), (9, "G5", 1), (10, "G5", 1), (11, "A5", 1), (12, "C6", 4)],
           26: [(0, "A5", 2), (2, "C6", 2), (4, "F6", 4), (8, "E6", 2), (10, "D6", 2), (12, "C6", 4)],
           27: [(0, "B5", 2), (2, "D6", 2), (4, "G6", 4), (8, "F6", 2), (10, "E6", 2), (12, "D6", 4)],
           28: [(0, "E6", 4), (4, "G6", 4), (8, "C7", 8)]}
    for bar in (25, 26, 27, 28):
        chord = CHORDS[bar]
        if bar > 25:
            sc.drums(bar, k="X.......X.......", s="....X.......X..." if bar < 28 else "....X...X.X.XXXX", h="x.x.x.x.x.x.x.x.", vel=0.85, crash=bar == 28)
            r = m(ROOT[chord]) - (12 if chord == "C" else 0)
            for k, off in enumerate((0, 7, 12, 7)):
                sc.tri(bar, k * 4, r + off, 4, 0.8)
            for st in (2, 6, 10, 14):
                sc.stab(bar, st, [m(x) + 12 for x in TONES[chord][:2]], 1, 0.12)
        else:
            sc.drums(bar, k="........X...X...", s="............X.X.", h="........x.x.x.x.", vel=0.8)
        sc.line("p1", bar, fan[bar], duty=0.5, vol=0.36)

    # ---- bars 29-32: stats — chill shop-menu groove --------------------------------------------------------------------
    walk = {29: ("F2", "A2", "C3", "E3"), 30: ("E2", "G2", "B2", "D3"), 31: ("D2", "F2", "A2", "C3"), 32: ("G2", "B2", "D3", "F3")}
    chill = {29: [(4, "A5", 2), (6, "C6", 2), (8, "E6", 4), (12, "D6", 4)], 30: [(4, "G5", 2), (6, "B5", 2), (8, "D6", 4), (12, "C6", 4)],
             31: [(4, "F5", 2), (6, "A5", 2), (8, "C6", 4), (12, "B5", 4)], 32: [(0, "B5", 2), (2, "D6", 2), (4, "G6", 8), (12, "F6", 2), (14, "D6", 2)]}
    for bar in (29, 30, 31, 32):
        sc.drums(bar, k="X.........X.....", s="....o.......o...", h="x.o.x.o.x.o.x.o.", vel=0.6)
        for k, n in enumerate(walk[bar]):
            sc.tri(bar, k * 4, n, 4, 0.7)
        ch = CHORDS[bar]
        for st in (2, 6, 10, 14):
            sc.stab(bar, st, [m(x) + 12 for x in TONES[ch][1:]], 1, 0.09, 0.125)
        sc.line("p1", bar, chill[bar], duty=0.25, vol=0.28)

    # ---- bars 33-36: end — final C with the sonic logo, short jingle, ring out ---------------------------------------
    sc.crash(33, 0, 0.9)
    a.put("kick", C.kick(1.0), sc.t(33, 0))
    for n in ("C6", "E6", "G6"):
        sc.p("p2", 33, 0, n, 3, 0.5, 0.16, 0.1, d=0.2, s=0.5, r=0.1)
    sc.tri(33, 0, "C2", 16, 0.85)
    sc.line("p1", 33, [(4, "E6", 2), (6, "G6", 2), (8, "C7", 8)], duty=0.5, vol=0.32)
    for i in range(16):
        n = ("C5", "E5", "G5", "C6")[i % 4]
        sc.p("p2", 34, i, n, 1, 0.125, 0.16 * (1 - i / 18), 0.22, d=0.05, s=0.5)
    sc.tri(34, 0, "C2", 16, 0.7)
    for n in ("C5", "G5", "E6"):
        sc.p("p2", 35, 0, n, 24, 0.5, 0.1, 0.1, a=0.05, d=1.5, s=0.3, r=0.6)
    sc.tri(35, 0, "C2", 12, 0.6)
    return {}
