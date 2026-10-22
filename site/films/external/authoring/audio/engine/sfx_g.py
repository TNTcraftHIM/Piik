"""Film G SFX (the evidence-board family), registered into the shared SFX library at import time — the shared engine
files and every other film's sounds are untouched. Same toy-like, rounded family as engine/sfx.py, with a little
more paper and wood (pins, string, rubber stamps, felt-tip marker). Every clip's t=0 is its transient."""
from __future__ import annotations

import numpy as np

from .core import SR, mtof, to_stereo
from . import dsp
from . import sfx as sfxlib
from .sfx import _sum, _ps, burst, blip, thump, noise_sweep, tone_sweep

TWO_PI = 2.0 * np.pi


def _at(x, s):
    """Delay a clip by s seconds (prepend silence)."""
    pad = np.zeros((int(round(s * SR)),) + x.shape[1:])
    return np.concatenate([pad, x], axis=0)


def _tone(f, dur, decay, attack=0.0008, f_from=None, glide=0.012):
    n = int(dur * SR)
    t = np.arange(n) / SR
    ff = np.full(n, f) if f_from is None else f * (f_from / f) ** np.exp(-t / glide)
    y = np.sin(TWO_PI * np.cumsum(ff) / SR) * np.exp(-t / decay) * np.minimum(t / attack, 1.0)
    return dsp.endfade(y, 2.0)


# ------------------------------------------------------------------------------------------------ the sounds
def g_string(pitch=0.0, seed=0, **_):
    """The red evidence string snapping taut: a low plucked twang that bends down fast, plus a dry rattle."""
    ps = _ps(pitch)
    rng = np.random.default_rng(611 + seed)
    n = int(0.55 * SR)
    t = np.arange(n) / SR
    f = 110.0 * ps * 2.0 ** (4.0 * np.exp(-t / 0.03) / 12.0)       # starts 4 st sharp, settles (string pulled taut)
    ph = TWO_PI * np.cumsum(f) / SR
    body = (np.sin(ph) + 0.45 * np.sin(2 * ph) + 0.22 * np.sin(3 * ph) + 0.1 * np.sin(5 * ph)) * np.exp(-t / 0.16)
    body *= np.minimum(t / 0.0015, 1.0)
    pluck = dsp.karplus(220.0 * ps, 0.4, rng, fb=0.992, damp=0.45, bright=0.8) * 0.5
    snap = burst(0.02, 5200.0, 0.8, 0.003, mode="hp", seed=612) * 0.5
    rattle = _at(burst(0.08, 2600.0, 3.0, 0.02, seed=613) * 0.12, 0.02)
    return _sum(dsp.endfade(body * 0.55), pluck, snap, rattle)


def g_pin(pitch=0.0, **_):
    """Push pin into a cork board: short wooden tock with a low push, then a paper flap."""
    ps = _ps(pitch)
    tock = burst(0.04, 1700.0 * ps, 3.2, 0.009, seed=621) * 0.8
    push = _tone(170.0 * ps, 0.08, 0.025, f_from=330.0 * ps, glide=0.006) * 0.7
    flap = _at(noise_sweep(0.09, 1800.0, 4800.0, q=1.1, peak_at=0.3, seed=622) * 0.22, 0.015)
    return _sum(tock, push, flap)


def g_click(pitch=0.0, **_):
    """Comic tactile click for every real UI click: crisp snap + hollow wood knock + a tiny pop up top."""
    ps = _ps(pitch)
    snap = burst(0.012, 6800.0, 0.8, 0.0016, mode="hp", seed=631) * 0.6
    knock = _tone(880.0 * ps, 0.06, 0.016, f_from=1500.0 * ps, glide=0.004) * 0.55
    thock = _tone(160.0 * ps, 0.08, 0.022, f_from=420.0 * ps, glide=0.005) * 0.8
    pop = _at(blip(mtof(91 + pitch), 0.04, 0.012) * 0.12, 0.004)
    rel = _at(_sum(burst(0.01, 3600.0 * ps, 2.0, 0.002, seed=632) * 0.25), 0.05)
    return _sum(snap, knock, thock, pop, rel)


def g_stamp(pitch=0.0, **_):
    """Rubber stamp on paper: low thump, paper slap and a small inky squelch."""
    ps = _ps(pitch)
    th = thump(92.0 * ps, 46.0 * ps, 0.1, 0.4, 1.5) * 0.9
    slap = burst(0.07, 1500.0 * ps, 0.8, 0.02, seed=641) * 0.7
    body = burst(0.12, 600.0 * ps, 0.7, 0.04, mode="lp", seed=642) * 0.55
    squelch = _at(noise_sweep(0.08, 380.0, 1100.0, q=3.0, peak_at=0.3, seed=643) * 0.18, 0.03)
    return _sum(th, slap, body, squelch)


def g_stamp_big(**_):
    """MISSION COMPLETE: the biggest stamp — sub thump, wood slam, paper rattle and a short room tail."""
    th = thump(78.0, 34.0, 0.17, 0.8, 1.9) * 1.0
    slam = burst(0.16, 480.0, 0.7, 0.06, mode="lp", seed=651) * 0.8
    crack = burst(0.05, 2200.0, 0.9, 0.012, seed=652) * 0.7
    rattle = _at(burst(0.12, 2900.0, 2.4, 0.03, seed=653) * 0.18, 0.03)
    rng = np.random.default_rng(654)
    n = int(0.9 * SR)
    t = np.arange(n) / SR
    tail = dsp.svf(rng.uniform(-1, 1, n), 900.0, 0.6, "lp") * np.exp(-t / 0.22) * 0.12
    st = np.stack([tail, np.roll(tail, 211)], axis=1)
    return _sum(th, slam, crack, rattle, dsp.endfade(st, 20.0))


def g_check(**_):
    """Red marker check mark: two quick felt-tip strokes (short, then long)."""
    a = noise_sweep(0.07, 2400.0, 3800.0, q=2.2, peak_at=0.35, pan0=-0.1, pan1=0.0, seed=661) * 0.45
    b = _at(noise_sweep(0.12, 2800.0, 5200.0, q=2.4, peak_at=0.25, pan0=0.0, pan1=0.2, seed=662) * 0.5, 0.075)
    return _sum(a, b)


def g_marker(**_):
    """Highlighter box drawn around the consent sentence: a squeaky felt-tip swipe with a faint pitched squeak."""
    sw = noise_sweep(0.42, 2000.0, 3600.0, q=3.6, peak_at=0.45, pan0=-0.3, pan1=0.3, seed=671) * 0.4
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    f = 1900.0 * 2.0 ** ((3.0 * t / 0.4 + 0.6 * np.sin(TWO_PI * 11.0 * t)) / 12.0)
    sq = np.sin(TWO_PI * np.cumsum(f) / SR) * np.sin(np.pi * np.clip(t / 0.4, 0, 1)) ** 2 * 0.05
    return _sum(sw, to_stereo(dsp.endfade(sq), 0.1))


def g_hit(note=74, **_):
    """Pong paddle hit inside the heist groove: woodblock 'pock' tuned to `note` plus a rim crack."""
    f = mtof(note)
    n = int(0.18 * SR)
    t = np.arange(n) / SR
    y = (np.sin(TWO_PI * f * t) + 0.35 * np.sin(TWO_PI * f * 2.76 * t) * np.exp(-t / 0.012)) * np.exp(-t / 0.045)
    y *= np.minimum(t / 0.0008, 1.0)
    crack = burst(0.02, 3200.0, 1.4, 0.004, seed=681) * 0.35
    return _sum(to_stereo(dsp.endfade(y * 0.7), 0.0), crack)


SFX_G = {"g_string": g_string, "g_pin": g_pin, "g_click": g_click, "g_stamp": g_stamp, "g_stamp_big": g_stamp_big,
         "g_check": g_check, "g_marker": g_marker, "g_hit": g_hit}
LEVEL_G = {"g_string": -4, "g_pin": -6, "g_click": -3, "g_stamp": -3, "g_stamp_big": 0, "g_check": -8, "g_marker": -8,
           "g_hit": -4}
BIG_G = {"g_stamp_big", "g_stamp"}

for _k in SFX_G:
    assert _k not in sfxlib.SFX or sfxlib.SFX[_k] is SFX_G[_k], f"SFX name clash: {_k}"
sfxlib.SFX.update(SFX_G)
sfxlib.LEVEL.update(LEVEL_G)
sfxlib.BIG |= BIG_G
