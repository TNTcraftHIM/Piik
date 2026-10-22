"""Film F SFX (gacha terminal, cards, the summon charge and the rainbow burst), registered into the shared SFX library
at import time. Names are prefixed f_ so they can never collide with (or change) the sounds of films A-E."""
from __future__ import annotations

import numpy as np

from engine.core import SR, mtof, to_stereo
from engine import dsp, fx
from engine import sfx as sfxlib
from engine.sfx import noise_sweep, tone_sweep, thump, burst, blip, gloss_bell, crackle, _sum, _pad, _r

TWO_PI = 2.0 * np.pi


def _place(out, clip, at, pan=0.0, gain=1.0):
    st = to_stereo(clip, pan) if clip.ndim == 1 else clip
    i = int(round(at * SR))
    if i >= out.shape[0]:
        return out
    m = min(st.shape[0], out.shape[0] - i)
    out[i:i + m] += st[:m] * gain
    return out


def f_boot(**_):
    """Industrial terminal power-on: relay clunk, low thump, rising digital chirp, a 4-blip boot arpeggio."""
    out = np.zeros((int(0.9 * SR), 2))
    _place(out, thump(150.0, 52.0, 0.12, 0.5, 1.6), 0.0, 0.0, 0.95)
    _place(out, burst(0.05, 2600.0, 1.4, 0.012, seed=901), 0.0, -0.2, 0.5)            # relay
    _place(out, burst(0.04, 3400.0, 1.6, 0.008, seed=902), 0.035, 0.25, 0.35)
    _place(out, tone_sweep(0.32, 260.0, 2600.0, "sq", decay=0.22) * 0.22, 0.04, 0.0)
    for k, nt in enumerate((72, 79, 84, 91)):
        _place(out, blip(mtof(nt), 0.05, 0.03, "sq"), 0.18 + 0.045 * k, -0.4 + 0.27 * k, 0.28)
    return out


def f_lock(**_):
    """Corner brackets clamping onto the window: two metal clicks and a short resonant ping."""
    out = np.zeros((int(0.5 * SR), 2))
    _place(out, burst(0.02, 4800.0, 6.0, 0.003, seed=911), 0.0, -0.35, 0.8)
    _place(out, burst(0.02, 5400.0, 6.0, 0.003, seed=912), 0.045, 0.35, 0.8)
    _place(out, gloss_bell(91, 0.4, 0.5, ratio=3.5, index=1.2, decay=0.12), 0.045, 0.1, 0.5)
    _place(out, thump(320.0, 160.0, 0.02, 0.08, 1.2), 0.045, 0.0, 0.4)
    return out


def f_click(**_):
    """Heavy tactile button press: crisp snap + low thock (deeper than ui_click)."""
    out = np.zeros((int(0.3 * SR), 2))
    _place(out, burst(0.012, 3200.0, 2.0, 0.0025, seed=921), 0.0, 0.0, 0.9)
    _place(out, thump(240.0, 95.0, 0.035, 0.15, 1.4), 0.004, 0.0, 0.85)
    _place(out, burst(0.03, 900.0, 1.2, 0.01, mode="lp", seed=922), 0.004, 0.0, 0.45)
    return out


def f_pulse(**_):
    """Broadcast pulse: soft sonar ping with two echoes moving across the field."""
    out = np.zeros((int(0.8 * SR), 2))
    ping = gloss_bell(84, 0.5, 0.7, ratio=2.0, index=0.3, decay=0.2)
    for k, (pan, g) in enumerate(((0.0, 1.0), (-0.5, 0.45), (0.5, 0.22))):
        _place(out, ping, 0.13 * k, pan, g)
    return out * 0.8


def f_deal(**_):
    """Ten cards dealt: fast swishes with tiny ticks."""
    out = np.zeros((int(0.55 * SR), 2))
    for k in range(10):
        sw = noise_sweep(0.07, 1800.0, 6500.0, q=1.4, peak_at=0.5, pan0=0.5, pan1=-0.6 + 0.13 * k, seed=930 + k) * 0.35
        _place(out, sw, 0.022 * k)
        _place(out, burst(0.01, 5000.0, 3.0, 0.002, seed=950 + k), 0.022 * k + 0.05, -0.5 + 0.11 * k, 0.25)
    return out


def f_flip(note=72, seed=0, **_):
    """Card flip: short paper swish + a pitched tick (the pitch sinks flip by flip in the dud)."""
    out = np.zeros((int(0.3 * SR), 2))
    _place(out, noise_sweep(0.05, 3200.0, 7500.0, q=1.6, peak_at=0.4, seed=960 + seed) * 0.4, 0.0)
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    f = mtof(note)
    y = (dsp.triangle(np.full(n, f)) * 0.7 + 0.3 * np.sin(TWO_PI * 2 * f * t)) * np.exp(-t / 0.045) * np.minimum(t / 0.001, 1.0)
    _place(out, dsp.endfade(y) * 0.5, 0.01, (note - 70) / 20.0)
    return out


def f_dud(**_):
    """The dud: deflating low womp + dull thud (sad, a little funny)."""
    out = np.zeros((int(0.9 * SR), 2))
    n = int(0.7 * SR)
    t = np.arange(n) / SR
    f = 230.0 * (68.0 / 230.0) ** (t / 0.7) * (1.0 + 0.04 * np.sin(TWO_PI * 7.0 * t))
    ph = np.cumsum(f) / SR
    y = dsp.svf(dsp.saw(f) * 0.6 + 0.4 * np.sin(TWO_PI * ph), 900.0, 0.8, "lp") * np.exp(-t / 0.35) * np.minimum(t / 0.01, 1.0)
    _place(out, dsp.endfade(y) * 0.55, 0.0)
    _place(out, thump(95.0, 42.0, 0.2, 0.6, 1.3), 0.0, 0.0, 0.8)
    _place(out, burst(0.08, 400.0, 0.8, 0.03, mode="lp", seed=971), 0.0, 0.0, 0.4)
    return out


def f_charge(dur=3.2, **_):
    """Summon charge: rising band noise + a saw glissando opening up, a pulse train that speeds up; peaks at the end."""
    rng = _r(981)
    n = int(dur * SR)
    t = np.arange(n) / n
    nz = dsp.svf(rng.uniform(-1, 1, n), 380.0 * (9000.0 / 380.0) ** t, 1.3, "bpn") * (0.15 + 0.85 * t ** 2.2) * 0.5
    f = mtof(40) * 2.0 ** (t * 2.0)                            # E2 -> E4
    tone = dsp.svf(dsp.saw(f) + dsp.saw(f * 1.5) * 0.6, 250.0 + 5200.0 * t ** 2, 1.1, "lp") * (0.1 + 0.9 * t ** 1.6) * 0.28
    trem = 1.0 - 0.35 * (0.5 + 0.5 * np.sin(TWO_PI * np.cumsum(4.0 + 18.0 * t ** 2) / SR))
    y = (nz + tone) * trem
    sec = np.arange(n) / SR
    k, tt = 0, 0.0
    while tt < dur - 0.02:                                     # pulses: 1/4 note -> 1/32 note
        h = thump(90.0, 48.0, 0.05, 0.15, 1.2) * (0.25 + 0.5 * tt / dur)
        i = int(tt * SR)
        m = min(h.shape[0], n - i)
        y[i:i + m] += h[:m]
        tt += max(0.05, 0.43 * (1.0 - tt / dur) ** 1.6)
        k += 1
    st = np.stack([y, np.roll(y, int(0.003 * SR))], axis=1)
    return dsp.endfade(st, 4.0)


def f_tier(note=76, **_):
    """Tier-up chime: bright bell triad + glint + a short upward whoosh."""
    out = np.zeros((int(1.0 * SR), 2))
    for k, iv in enumerate((0, 7, 12)):
        _place(out, gloss_bell(note + iv, 0.8, 0.55 - 0.1 * k, ratio=2.0, index=0.7, decay=0.3), 0.012 * k, -0.3 + 0.3 * k)
    _place(out, gloss_bell(min(108, note + 24), 0.4, 0.25, decay=0.1), 0.05, 0.4)
    _place(out, noise_sweep(0.3, 1500.0, 8000.0, q=1.1, peak_at=0.25, seed=991 + note) * 0.25, 0.0)
    return out


def f_burst(**_):
    """THE rainbow burst: huge impact, sub drop, crack, glass-shimmer cascade up the scale, long airy tail."""
    out = np.zeros((int(2.6 * SR), 2))
    _place(out, thump(64.0, 28.0, 0.9, 2.4, 1.9), 0.0, 0.0, 1.0)
    _place(out, burst(0.08, 3400.0, 1.0, 0.022, seed=1001), 0.0, 0.0, 0.8)
    _place(out, dsp.soft_clip(burst(0.25, 1600.0, 0.5, 0.08, mode="lp", seed=1002) * 3.0, 2.5) * 0.3, 0.0)
    _place(out, tone_sweep(0.7, 360.0, 42.0, "sine", decay=0.3) * 0.45, 0.0)
    notes = [72, 76, 79, 84, 88, 91, 96, 100, 103, 108]
    for k, nt in enumerate(notes):
        _place(out, gloss_bell(nt, 0.7, 0.42 - 0.02 * k, ratio=2.0, index=0.6, decay=0.18), 0.03 + 0.045 * k, -0.8 + 1.6 * k / 9)
    air = burst(2.2, 4000.0, 0.6, 1.0, mode="hp", seed=1003)
    _place(out, fx.lp(air, 11000.0) * 0.12, 0.05)
    _place(out, noise_sweep(0.5, 9000.0, 1200.0, q=0.9, peak_at=0.08, pan0=-0.6, pan1=0.6, seed=1004) * 0.35, 0.0)
    return out


SFX_F = {"f_boot": f_boot, "f_lock": f_lock, "f_click": f_click, "f_pulse": f_pulse, "f_deal": f_deal, "f_flip": f_flip,
         "f_dud": f_dud, "f_charge": f_charge, "f_tier": f_tier, "f_burst": f_burst}
LEVEL_F = {"f_boot": -3, "f_lock": -6, "f_click": -4, "f_pulse": -8, "f_deal": -6, "f_flip": -7, "f_dud": -2,
           "f_charge": -6, "f_tier": -6, "f_burst": 0}
BIG_F = {"f_boot", "f_dud", "f_burst"}

for _k in SFX_F:
    assert _k not in sfxlib.SFX or sfxlib.SFX[_k] is SFX_F[_k], f"SFX name clash: {_k}"
sfxlib.SFX.update(SFX_F)
sfxlib.LEVEL.update(LEVEL_F)
sfxlib.BIG |= BIG_F
