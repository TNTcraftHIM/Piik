"""Film D SFX (the 'click' family), registered into the shared SFX library at import time — the engine files are
untouched. Same toy-like, glossy, rounded family as engine/sfx.py; every clip's t=0 is its transient."""
from __future__ import annotations

import numpy as np

from engine.core import SR, mtof, to_stereo
from engine import dsp, inst
from engine import sfx as sfxlib
from engine.sfx import _sum, _ps, burst, blip, thump, noise_sweep, tone_sweep, gloss_bell

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
def click_big(pitch=0.0, seed=0, **_):
    """THE motif: a crisp, satisfying tactile snap — bright tick + plastic 'tock' + low thock, then a small release
    click 55 ms later (the button coming back up). `pitch` in semitones."""
    ps = _ps(pitch)
    snap = burst(0.012, 6500.0, 0.8, 0.0016, mode="hp", seed=431) * 0.55
    tock = burst(0.05, 1500.0 * ps, 4.5, 0.011, seed=432) * 0.75
    thock = _tone(150.0 * ps, 0.09, 0.026, f_from=420.0 * ps, glide=0.006) * 0.85
    sheen = _tone(mtof(88 + pitch), 0.09, 0.022) * 0.07
    rel = _at(_sum(burst(0.012, 3600.0 * ps, 2.0, 0.0022, seed=433) * 0.28, _tone(260.0 * ps, 0.04, 0.01) * 0.25), 0.055)
    return _sum(snap, tock, thock, sheen, rel)


def card_drop(**_):
    """A rounded device card landing on a soft surface: felt thump + puff + a tiny two-step plastic rattle."""
    th = thump(150.0, 58.0, 0.075, 0.4, 1.3) * 0.9
    puff = burst(0.1, 560.0, 0.6, 0.03, mode="lp", seed=401) * 0.6
    tk = burst(0.03, 2300.0, 1.4, 0.006, seed=402) * 0.32
    r1 = _at(burst(0.03, 3400.0, 2.2, 0.005, seed=403) * 0.16, 0.048)
    r2 = _at(burst(0.03, 3900.0, 2.2, 0.004, seed=404) * 0.09, 0.08)
    return _sum(th, puff, tk, r1, r2)


def chip_pop(note=76, **_):
    """Bubbly tactile pop for a callout chip: a quick upward 'bloop' into the note + octave gloss + tiny click."""
    f = mtof(note)
    body = _tone(f, 0.17, 0.05, f_from=f * 0.62, glide=0.009) * 0.6
    gloss = _tone(2 * f, 0.08, 0.022) * 0.16
    click = burst(0.008, 5200.0, 1.0, 0.0015, seed=411) * 0.22
    return _sum(body, gloss, click)


def stepper_tick(note=72, **_):
    """Chapter rail advance: short bright glassy tick on the note + a soft click."""
    bell = gloss_bell(note, 0.3, 0.55, ratio=2.0, index=0.55, decay=0.07)
    tick = burst(0.012, 6000.0, 1.2, 0.0018, seed=421) * 0.3
    thock = blip(380.0, 0.03, 0.008) * 0.25
    return _sum(to_stereo(bell, 0.0), tick, thock)


def split_click(**_):
    """The two screens slide apart: a magnetic double click (L then R, 14 ms flam) + a short widening slide."""
    l = to_stereo(click_big(1.0)[:, 0], -0.55)
    r = _at(to_stereo(click_big(1.5)[:, 0], 0.55), 0.014)
    slide_l = noise_sweep(0.34, 2600.0, 900.0, q=0.9, peak_at=0.12, pan0=-0.1, pan1=-0.8, seed=441) * 0.3
    slide_r = noise_sweep(0.34, 2800.0, 950.0, q=0.9, peak_at=0.12, pan0=0.1, pan1=0.8, seed=442) * 0.3
    mag = to_stereo(_tone(95.0, 0.14, 0.05, f_from=190.0, glide=0.02) * 0.45)
    return _sum(l * 0.8, r * 0.8, slide_l, slide_r, mag)


def pong_hit(note=72, **_):
    """Paddle hit: woody marimba 'pock' on the note + a soft retro square 'pong' + contact click."""
    f = mtof(note)
    wood = to_stereo(inst.marimba(note, 0.9, dur=0.4))
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    sq = dsp.svf(dsp.pulse(np.full(n, f), 0.5), 2600.0, 0.7, "lp") * np.exp(-t / 0.045) * np.minimum(t / 0.001, 1.0)
    k = burst(0.01, 4500.0, 1.0, 0.0015, seed=451) * 0.22
    return _sum(wood * 0.78, dsp.endfade(sq, 2.0) * 0.2, k)


def pong_point(**_):
    """Point jingle: A5 - C6 - F6 bell arpeggio (F major) with a marimba under the last note."""
    out = []
    for k, (note, d) in enumerate(((81, 0.3), (84, 0.3), (89, 0.9))):
        b = gloss_bell(note, d, 0.75, ratio=2.0, index=0.8, decay=0.12 if k < 2 else 0.34)
        out.append(_at(to_stereo(b, (-0.25, 0.25, 0.0)[k]), 0.085 * k))
    out.append(_at(to_stereo(inst.marimba(77, 0.6, dur=0.5)), 0.17))
    out.append(_at(to_stereo(inst.marimba(65, 0.5, dur=0.5)), 0.17))
    return _sum(*out) * 0.8


SFX_D = {"click_big": click_big, "card_drop": card_drop, "chip_pop": chip_pop, "stepper_tick": stepper_tick,
         "split_click": split_click, "pong_hit": pong_hit, "pong_point": pong_point}
LEVEL_D = {"click_big": -3, "card_drop": -3, "chip_pop": -10, "stepper_tick": -9, "split_click": -3, "pong_hit": -4,
           "pong_point": -4}
BIG_D = {"click_big", "card_drop", "split_click"}

for _k in SFX_D:
    assert _k not in sfxlib.SFX or sfxlib.SFX[_k] is SFX_D[_k], f"SFX name clash: {_k}"
sfxlib.SFX.update(SFX_D)
sfxlib.LEVEL.update(LEVEL_D)
sfxlib.BIG |= BIG_D
