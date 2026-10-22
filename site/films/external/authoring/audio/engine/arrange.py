"""Arranger: named tracks on a Grid, pattern-string drums, cached drum voices, swing/humanize, event log.

Score scripts call  a.drum('kick', bar, 'X......x..x.....'),  a.note('bass', bar, step, clip)  etc.
Times: step positions are swung 16ths (Grid.step_t); hit positions use exact beats (Grid.t) so cue hits stay exact.
"""
from __future__ import annotations

import numpy as np

from .core import SR, Bus, Grid
from . import drums

VEL = {"X": 1.0, "x": 0.8, "o": 0.45, "g": 0.3, "h": 0.6}


def pattern(s: str):
    """'X..x o...' -> [(step, vel)], spaces ignored, digits 1-9 = 0.1..0.9."""
    s = s.replace(" ", "")
    out = []
    for i, c in enumerate(s):
        if c in VEL:
            out.append((i, VEL[c]))
        elif c.isdigit() and c != "0":
            out.append((i, int(c) / 10.0))
    return out


class Arranger:
    def __init__(self, grid: Grid, seconds: float, seed: int = 0):
        self.g = grid
        self.seconds = seconds
        self.tracks: dict[str, Bus] = {}
        self.rng = np.random.default_rng(seed)
        self.kick_times: list[float] = []
        self.sc_extra: list[float] = []  # extra sidechain triggers (ghost kicks for pumping)
        self._cache: dict = {}

    def bus(self, name: str) -> Bus:
        if name not in self.tracks:
            self.tracks[name] = Bus(self.seconds, name)
        return self.tracks[name]

    # -------------------------------------------------------------------------------------------- timing
    def st(self, bar, step, human_ms=0.0):
        t = self.g.step_t(bar, step)
        if human_ms:
            t += float(np.clip(self.rng.normal(0, human_ms / 2000.0), -human_ms / 1000.0, human_ms / 1000.0))
        return t

    def bt(self, bar, beat):
        return self.g.t(bar, beat)

    # ---------------------------------------------------------------------------------------------- drums
    def _voice(self, kind: str, variant: int):
        key = (kind, variant)
        if key not in self._cache:
            seed = 1000 + variant * 17 + sum(map(ord, kind))  # stable across runs (no str hash)
            fn = {
                "kick": lambda: drums.kick(1.0, seed=seed),
                "kick_tight": lambda: drums.kick(1.0, decay=0.18, seed=seed),
                "kick_boom": lambda: drums.kick(1.0, decay=0.45, f_lo=42.0, seed=seed),
                "snare": lambda: drums.snare(1.0, seed=seed),
                "snare_ghost": lambda: drums.snare(1.0, snappy=0.5, decay=0.08, seed=seed),
                "clap": lambda: drums.clap(1.0, seed=seed),
                "hat": lambda: drums.hat(1.0, seed=seed),
                "ohat": lambda: drums.hat(1.0, open_=True, seed=seed),
                "shaker": lambda: drums.shaker(1.0, seed=seed),
                "rim": lambda: drums.rim(1.0, seed=seed),
                "ride": lambda: drums.ride(1.0, seed=seed),
                "crash": lambda: drums.crash(1.0, seed=seed),
            }[kind]
            self._cache[key] = fn()
        return self._cache[key]

    def hit(self, track: str, kind: str, t: float, vel: float = 1.0, pan: float = 0.0, variants: int = 4):
        v = int(self.rng.integers(0, variants))
        clip = self._voice(kind, v) * vel
        self.bus(track).add(clip, t, 0.0, pan)
        if kind.startswith("kick"):
            self.kick_times.append(t)

    def drum(self, track: str, bar: int, pat: str, kind: str | None = None, vel: float = 1.0, human_ms=0.0,
             pan: float = 0.0, skip=()):
        kind = kind or track
        for step, v in pattern(pat):
            if step in skip:
                continue
            t = self.st(bar, step, human_ms)
            vv = v * vel * float(self.rng.uniform(0.95, 1.03))
            self.hit(track, kind, t, vv, pan)

    # ---------------------------------------------------------------------------------------------- notes
    def put(self, track: str, clip, t: float, gain_db: float = 0.0, pan: float = 0.0):
        self.bus(track).add(clip, t, gain_db, pan)
