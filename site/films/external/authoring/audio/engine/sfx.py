"""SFX library. One family: toy-like, glossy, rounded — sine/triangle bodies, band-limited noise, short tails.

Every generator returns a stereo clip whose t=0 is the cue time (the transient). Generators that need a length
(risers) take `dur` and peak exactly at the end. Pitched generators take a MIDI `note`; others accept `pitch`
in semitones. Register new sounds in SFX at the bottom; the placer in place.py looks them up by cue name.
"""
from __future__ import annotations

import math

import numpy as np

from .core import SR, mtof, to_stereo
from . import dsp
from . import fx
from . import inst

TWO_PI = 2.0 * math.pi


def _r(seed):
    return np.random.default_rng(seed)


def _st(x, pan=0.0):
    return to_stereo(x, pan) if x.ndim == 1 else x


def _pad(x, n):
    if x.shape[0] >= n:
        return x[:n]
    shape = (n - x.shape[0],) + x.shape[1:]
    return np.concatenate([x, np.zeros(shape)], axis=0)


def _sum(*parts):
    n = max(p.shape[0] for p in parts)
    out = np.zeros((n, 2))
    for p in parts:
        out += _pad(_st(p), n)
    return out


def _ps(pitch):
    return 2.0 ** (pitch / 12.0)


# --------------------------------------------------------------------------------------------- building blocks
def noise_sweep(dur, f0, f1, q=1.2, peak_at=0.4, pan0=0.0, pan1=0.0, seed=0, shape=1.0, pink=False):
    """Band-passed noise whose centre glides f0->f1 (exponential) under a bell envelope; auto-pans pan0->pan1."""
    rng = _r(seed)
    n = int(dur * SR)
    t = np.arange(n) / n
    src = dsp.pink(n, rng) * 3.0 if pink else rng.uniform(-1, 1, n)
    fc = f0 * (f1 / f0) ** t
    y = dsp.svf(src, fc, q, "bpn")
    env = np.where(t < peak_at, (t / max(peak_at, 1e-3)) ** shape, ((1 - t) / max(1 - peak_at, 1e-3)) ** (shape * 1.5))
    y *= env
    pan = pan0 + (pan1 - pan0) * t
    gl = np.cos((pan + 1) * math.pi / 4)
    gr = np.sin((pan + 1) * math.pi / 4)
    return np.stack([y * gl, y * gr], axis=1)


def tone_sweep(dur, f0, f1, wave="sine", decay=None, attack=0.003):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f0 * (f1 / f0) ** (t / dur)
    if wave == "sine":
        y = dsp.sine(f)
    elif wave == "tri":
        y = dsp.triangle(f)
    else:
        y = dsp.svf(dsp.pulse(f, 0.5), 3000.0, 0.7, "lp")
    env = np.minimum(t / attack, 1.0)
    if decay:
        env *= np.exp(-t / decay)
    return dsp.endfade(y * env)


def thump(f_hi=110.0, f_lo=45.0, decay=0.09, dur=0.35, drive=1.4):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f_lo + (f_hi - f_lo) * np.exp(-t / 0.025)
    y = np.sin(TWO_PI * np.cumsum(f) / SR) * np.exp(-t / decay)
    y[: int(0.001 * SR)] *= np.linspace(0, 1, int(0.001 * SR))
    return dsp.endfade(dsp.soft_clip(y, drive))


def burst(dur, fc, q=0.9, decay=0.02, mode="bpn", seed=0):
    rng = _r(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = dsp.svf(rng.uniform(-1, 1, n), fc, q, mode) * np.exp(-t / decay)
    return dsp.endfade(y, 2.0)


def blip(f, dur=0.03, decay=0.012, wave="sine", f_end=None):
    n = int(dur * SR)
    t = np.arange(n) / SR
    ff = np.full(n, f) if f_end is None else f * (f_end / f) ** (t / dur)
    y = dsp.sine(ff) if wave == "sine" else dsp.svf(dsp.pulse(ff, 0.5), 4500.0, 0.7, "lp")
    y *= np.minimum(t / 0.0015, 1.0) * np.exp(-t / decay)
    return dsp.endfade(y, 2.0)


def gloss_bell(note, dur=0.6, vel=1.0, ratio=2.0, index=0.9, decay=0.25, seed=0):
    """Glassy toy bell: harmonic FM (ratio 2) so it stays consonant with the chord."""
    f = mtof(note)
    n = int(dur * SR)
    t = np.arange(n) / SR
    guard = min(1.0, 1600.0 / f)
    idx = index * guard * np.exp(-t / (decay * 0.3))
    y = np.sin(TWO_PI * f * t + idx * np.sin(TWO_PI * f * ratio * t))
    y += 0.18 * np.sin(TWO_PI * f * 3.0 * t) * np.exp(-t / (decay * 0.3))
    y *= np.exp(-t / decay) * np.minimum(t / 0.0012, 1.0)
    return dsp.endfade(y * vel)


def crackle(dur, density=60.0, fc=3500.0, seed=0):
    rng = _r(seed)
    n = int(dur * SR)
    y = np.zeros(n)
    k = int(density * dur)
    pos = rng.integers(0, n, k)
    amps = rng.uniform(0.2, 1.0, k) * rng.choice([-1, 1], k)
    y[pos] = amps
    y = dsp.svf(y, fc, 0.8, "bpn")
    return y


# ----------------------------------------------------------------------------------------------- the library
def tv_on(**_):
    relay = thump(140.0, 60.0, 0.05, 0.25) * 0.7
    zap = tone_sweep(0.16, 2300.0, 170.0, "tri", decay=0.07) * 0.45
    stat = noise_sweep(0.45, 5200.0, 1800.0, q=0.7, peak_at=0.05, seed=3) * 0.55
    crk = to_stereo(crackle(0.5, 90.0, 3200.0, seed=4) * np.exp(-np.arange(int(0.5 * SR)) / SR / 0.2), 0.0) * 0.9
    bloom = noise_sweep(0.3, 400.0, 2400.0, q=0.8, peak_at=0.25, seed=5) * 0.25
    return _sum(relay, zap, stat, crk, bloom)


def box_in(**_):
    sw = noise_sweep(0.16, 700.0, 3200.0, q=1.3, peak_at=0.7, pan0=-0.2, pan1=0.1, seed=11) * 0.55
    tick = np.concatenate([np.zeros(int(0.115 * SR)), blip(2300.0, 0.03, 0.008)]) * 0.45
    return _sum(sw, tick)


def whoosh_short(pitch=0.0, **_):
    p = _ps(pitch)
    return noise_sweep(0.3, 450.0 * p, 2700.0 * p, q=1.1, peak_at=0.4, pan0=-0.5, pan1=0.5, seed=21) * 0.8


def sigh_deflate(**_):
    nz = noise_sweep(0.7, 2300.0, 330.0, q=1.6, peak_at=0.12, seed=31, shape=0.7) * 0.5
    tone = tone_sweep(0.6, mtof(64), mtof(57), "tri", decay=0.35) * 0.18
    return _sum(nz, tone)


def panel_slam(**_):
    th = thump(115.0, 48.0, 0.09, 0.4) * 0.9
    slap = burst(0.08, 1900.0, 0.8, 0.022, seed=41) * 0.75
    thwack = burst(0.12, 650.0, 1.1, 0.04, seed=42) * 0.5
    return _sum(th, slap, thwack)


def type_tick(**_):
    return _sum(burst(0.03, 3600.0, 1.2, 0.004, seed=51) * 0.5, blip(2600.0, 0.025, 0.007) * 0.35)


def cutin_whoosh(**_):
    sw = noise_sweep(0.32, 260.0, 7200.0, q=0.9, peak_at=0.45, pan0=-0.8, pan1=0.8, seed=61, shape=1.6) * 0.9
    shk = burst(0.05, 4200.0, 0.9, 0.012, seed=62) * 0.4
    swell = tone_sweep(0.3, 90.0, 150.0, "sine", decay=0.12) * 0.35
    return _sum(sw, shk, swell)


def shing(**_):
    n = int(0.75 * SR)
    t = np.arange(n) / SR
    f = mtof(100)  # E7
    trem = 1.0 + 0.35 * np.sin(TWO_PI * 17.0 * t)
    y = (np.sin(TWO_PI * f * t + 0.6 * np.exp(-t / 0.05) * np.sin(TWO_PI * f * 1.41 * t))
         + 0.4 * np.sin(TWO_PI * mtof(107) * t) * np.exp(-t / 0.18))
    y *= np.exp(-t / 0.28) * trem * np.minimum(t / 0.002, 1.0)
    flick = noise_sweep(0.08, 3000.0, 9000.0, q=1.0, peak_at=0.6, seed=71) * 0.35
    st = np.stack([y * 0.9, np.roll(y, int(0.004 * SR)) * 0.9], axis=1) * 0.35
    return _sum(dsp.endfade(st), flick)


def ransom_slap(note=72, **_):
    slap = burst(0.06, 2100.0, 0.8, 0.014, seed=81) * 0.55
    tone = inst.marimba(note, 0.9, 0.32) * 0.6
    pop = blip(mtof(note) * 2.0, 0.03, 0.01) * 0.12
    return _sum(slap, tone, pop)


def piik_chirp(**_):
    """Brand sonic logo: 'pi' (B5) then 'ik!' flicking up into E6, whistle-bell timbre with a tiny sparkle."""
    def voice(f_from, f_to, dur, flick, decay):
        n = int(dur * SR)
        t = np.arange(n) / SR
        f = f_to * (f_from / f_to) ** np.exp(-t / flick) if flick else np.full(n, f_to)
        ph = np.cumsum(f) / SR
        y = np.sin(TWO_PI * ph) + 0.22 * np.sin(2 * TWO_PI * ph) + 0.06 * np.sin(3 * TWO_PI * ph)
        y += 0.5 * np.sin(TWO_PI * ph + 0.9 * np.exp(-t / 0.02) * np.sin(2 * TWO_PI * ph)) * np.exp(-t / 0.05)
        env = np.minimum(t / 0.004, 1.0) * np.exp(-t / decay)
        return dsp.endfade(y * env, 6.0)
    pi = voice(mtof(83), mtof(83), 0.085, 0.0, 0.05)                 # B5
    ik = voice(mtof(86), mtof(88), 0.34, 0.012, 0.13)                # D6 -> E6 flick
    sp = gloss_bell(100, 0.35, 0.25, decay=0.09)                     # E7 glint
    out = np.zeros((int(0.6 * SR), 2))
    for clip, at, pan, g in ((pi, 0.0, -0.08, 0.55), (ik, 0.105, 0.06, 0.7), (sp, 0.16, 0.3, 0.6)):
        i = int(at * SR)
        st = to_stereo(clip, pan) * g
        out[i:i + st.shape[0]] += st[: out.shape[0] - i]
    return out


def sparkle(seed=0, **_):
    rng = _r(91 + seed)
    notes = [96, 98, 100, 103, 105, 108]
    out = np.zeros((int(0.7 * SR), 2))
    for k in range(5):
        nt = int(rng.choice(notes))
        clip = gloss_bell(nt, 0.4, 0.5 * (1 - 0.13 * k), index=0.5, decay=0.12)
        i = int((0.035 * k + rng.uniform(0, 0.01)) * SR)
        st = to_stereo(clip, float(rng.uniform(-0.6, 0.6)))
        out[i:i + st.shape[0]] += st[: out.shape[0] - i]
    shimmer = noise_sweep(0.3, 6000.0, 9000.0, q=1.5, peak_at=0.2, seed=92) * 0.08
    return _sum(out, shimmer)


def card_fly(pitch=0.0, **_):
    return noise_sweep(0.14, 1500.0, 4200.0, q=1.2, peak_at=0.35, pan0=0.5, pan1=-0.2, seed=101) * 0.45


def ui_hover(**_):
    return to_stereo(blip(1250.0, 0.07, 0.035, f_end=1500.0) * 0.3)


def ui_click(**_):
    return _sum(burst(0.02, 4200.0, 0.7, 0.0025, mode="hp", seed=111) * 0.45,
                blip(1900.0, 0.03, 0.009) * 0.5, blip(230.0, 0.04, 0.014) * 0.6)


def card_flip(**_):
    f1 = burst(0.04, 3100.0, 1.0, 0.008, seed=121) * 0.5
    f2 = np.concatenate([np.zeros(int(0.045 * SR)), burst(0.04, 3600.0, 1.0, 0.008, seed=122) * 0.45])
    tone = tone_sweep(0.07, 900.0, 1650.0, "sine", decay=0.03) * 0.25
    return _sum(f1, f2, tone)


def whoosh_up(**_):
    sw = noise_sweep(0.45, 220.0, 5200.0, q=1.0, peak_at=0.75, pan0=-0.3, pan1=0.3, seed=131, shape=1.8) * 0.8
    tone = tone_sweep(0.4, 300.0, 1250.0, "sine", decay=0.25) * 0.12
    return _sum(sw, tone)


def stamp(**_):
    th = thump(80.0, 44.0, 0.11, 0.45, 1.6) * 0.95
    body = burst(0.12, 700.0, 0.7, 0.045, mode="lp", seed=141) * 0.7
    ka = burst(0.05, 1250.0, 1.3, 0.018, seed=142) * 0.55
    rattle = np.concatenate([np.zeros(int(0.03 * SR)), burst(0.06, 2400.0, 2.0, 0.012, seed=143) * 0.15])
    return _sum(th, body, ka, rattle)


def ui_confirm(**_):
    a = gloss_bell(88, 0.35, 0.6, decay=0.14)
    b = gloss_bell(93, 0.45, 0.6, decay=0.18)
    out = np.zeros((int(0.55 * SR), 2))
    out[: a.shape[0]] += to_stereo(a, -0.1)
    i = int(0.07 * SR)
    out[i:i + b.shape[0]] += to_stereo(b, 0.1)[: out.shape[0] - i]
    return out * 0.8


def card_throw(**_):
    n = int(0.6 * SR)
    t = np.arange(n) / SR
    sw = noise_sweep(0.6, 520.0, 3600.0, q=1.0, peak_at=0.3, pan0=-0.6, pan1=0.7, seed=151, shape=1.2)
    flutter = 0.6 + 0.4 * np.sin(TWO_PI * 23.0 * t)
    sw = sw * flutter[:, None]
    fwip = burst(0.04, 3000.0, 1.0, 0.008, seed=152) * 0.4
    return _sum(sw * 0.85, fwip)


def notif_ding(note=81, **_):
    main = gloss_bell(note, 0.8, 0.8, ratio=3.0, index=0.7, decay=0.32)
    octv = gloss_bell(note + 12, 0.5, 0.2, ratio=2.0, index=0.4, decay=0.15)
    st = to_stereo(main + _pad(octv, main.shape[0]), 0.0)
    return st * 0.75


def pop(note=81, **_):
    n = int(0.14 * SR)
    t = np.arange(n) / SR
    f = mtof(note) * 2.0 ** (-5.0 * np.exp(-t / 0.012) / 12.0)
    y = np.sin(TWO_PI * np.cumsum(f) / SR) * np.exp(-t / 0.05) * np.minimum(t / 0.001, 1.0)
    click = burst(0.01, 3000.0, 1.0, 0.002, seed=161) * 0.2
    return _sum(dsp.endfade(y * 0.6), click)


def riser_short(dur=1.875, **_):
    rng = _r(171)
    n = int(dur * SR)
    t = np.arange(n) / n
    nz = dsp.svf(rng.uniform(-1, 1, n), 400.0 * (9000.0 / 400.0) ** t, 1.3, "bpn") * t ** 2.2
    f = mtof(57) * 2.0 ** t  # A3 -> A4
    tone = (dsp.saw(f) + dsp.saw(f * 1.005)) * 0.5
    tone = dsp.svf(tone, 500.0 + 4500.0 * t ** 2, 0.8, "lp") * t ** 2.5 * 0.35
    y = nz * 0.7 + tone
    st = np.stack([y, np.roll(y, int(0.003 * SR))], axis=1)
    return dsp.endfade(st, 8.0)


def plop_land(note=69, **_):
    cush = thump(120.0, 55.0, 0.09, 0.3) * 0.75
    fw = burst(0.12, 420.0, 0.7, 0.05, mode="lp", seed=181) * 0.55
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = mtof(note) * 2.0 ** ((-3.0 * np.exp(-t / 0.02) + 0.7 * np.sin(TWO_PI * 13.0 * t) * np.exp(-t / 0.1)) / 12.0)
    boing = np.sin(TWO_PI * np.cumsum(f) / SR) + 0.25 * np.sin(2 * TWO_PI * np.cumsum(f) / SR)
    boing *= np.exp(-t / 0.17) * np.minimum(t / 0.004, 1.0)
    boing = np.concatenate([np.zeros(int(0.012 * SR)), dsp.endfade(boing)]) * 0.45
    return _sum(cush, fw, boing)


def counter_tick(**_):
    a = burst(0.012, 4200.0, 1.2, 0.0025, seed=191) * 0.4
    b = np.concatenate([np.zeros(int(0.012 * SR)), burst(0.012, 3600.0, 1.2, 0.0025, seed=192) * 0.35])
    c = blip(3200.0, 0.025, 0.006) * 0.2
    return _sum(a, b, c)


def title_slam(**_):
    boom = thump(65.0, 38.0, 0.33, 1.0, 1.5) * 1.0
    body = burst(0.2, 2800.0, 0.6, 0.06, mode="lp", seed=201) * 0.8
    crack = burst(0.05, 2500.0, 1.0, 0.012, seed=202) * 0.6
    tail = burst(0.9, 6000.0, 0.7, 0.35, mode="hp", seed=203) * 0.12
    return _sum(boom, body, crack, tail)


def danmaku_tick(seed=0, **_):
    rng = _r(211 + seed)
    pan = float(rng.uniform(-0.6, 0.6))
    return to_stereo(burst(0.02, 6500.0, 1.0, 0.003, mode="hp", seed=212 + seed) * 0.25
                     + _pad(blip(2400.0, 0.02, 0.006), int(0.02 * SR)) * 0.2, pan)


def label_blip(**_):
    a = blip(mtof(93), 0.035, 0.02, wave="sq")
    b = blip(mtof(98), 0.05, 0.025, wave="sq")
    y = np.concatenate([a, b]) * 0.22
    return to_stereo(y, 0.15)


def throw_whoosh(**_):
    return noise_sweep(0.28, 650.0, 3200.0, q=1.1, peak_at=0.55, pan0=-0.5, pan1=0.1, seed=221, shape=1.4) * 0.7


def splat(pitch=0.0, seed=0, **_):
    p = _ps(pitch)
    rng = _r(231 + seed)
    th = thump(145.0 * p, 70.0 * p, 0.05, 0.25) * 0.55
    wet = burst(0.1, 1800.0 * p, 0.7, 0.035, mode="lp", seed=232 + seed) * 0.6
    n = int(0.2 * SR)
    t = np.arange(n) / n
    sq = dsp.svf(rng.uniform(-1, 1, n), 1800.0 * p * (330.0 / 1800.0) ** t, 4.0, "bpn") * (1 - t) ** 1.5 * 0.6
    drops = np.zeros(int(0.3 * SR))
    for k in range(4):
        i = int(rng.uniform(0.05, 0.22) * SR)
        d = blip(float(rng.uniform(1900, 3100)) * p, 0.02, 0.006) * 0.12
        drops[i:i + d.shape[0]] += d[: drops.shape[0] - i]
    return _sum(th, wet, sq, to_stereo(drops, float(rng.uniform(-0.3, 0.3))))


def poop_boing(**_):
    n = int(0.62 * SR)
    t = np.arange(n) / SR
    f = mtof(55) * 2.0 ** ((1.3 * np.exp(-t / 0.2) * np.sin(TWO_PI * 11.0 * t) + 2.0 * (1 - np.exp(-t / 0.05))) / 12.0)
    y = np.sin(TWO_PI * np.cumsum(f) / SR) + 0.3 * np.sin(2 * TWO_PI * np.cumsum(f) / SR)
    y *= np.exp(-t / 0.22) * np.minimum(t / 0.005, 1.0)
    plop = thump(160.0, 80.0, 0.04, 0.2) * 0.4
    return _sum(dsp.endfade(y) * 0.5, plop)


def voice_on(**_):
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    f = mtof(81) * (mtof(88) / mtof(81)) ** np.clip(t / 0.06, 0, 1)
    y = np.sin(TWO_PI * np.cumsum(f) / SR) * np.exp(-t / 0.1) * np.minimum(t / 0.004, 1.0)
    wh = tone_sweep(0.12, 150.0, 210.0, "sine", decay=0.05, attack=0.02) * 0.3
    return _sum(dsp.endfade(y) * 0.4, wh)


def request_chime(**_):
    out = np.zeros((int(0.8 * SR), 2))
    for k, nt in enumerate((76, 83, 88)):
        c = to_stereo(gloss_bell(nt, 0.5, 0.55, decay=0.2), -0.2 + 0.2 * k)
        i = int(0.075 * k * SR)
        out[i:i + c.shape[0]] += c[: out.shape[0] - i]
    return out * 0.75


def handover_zap(**_):
    rng = _r(241)
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    buzz = dsp.saw(110.0 * (1.0 + 0.5 * rng.uniform(-1, 1, n)))
    buzz = dsp.svf(buzz, 900.0 + 3500.0 * np.exp(-t / 0.08), 1.5, "bpn") * np.exp(-t / 0.09)
    crk = crackle(0.35, 220.0, 4000.0, seed=242) * np.exp(-t / 0.1)
    up = tone_sweep(0.32, 220.0, 1600.0, "sq", decay=0.2) * 0.22
    sw = noise_sweep(0.4, 400.0, 5000.0, q=1.0, peak_at=0.35, pan0=-0.4, pan1=0.5, seed=243) * 0.4
    return _sum(to_stereo(buzz * 0.45 + crk * 0.5), up, sw)


def tension_riser(dur=0.9375, **_):
    rng = _r(251)
    n = int(dur * SR)
    t = np.arange(n) / n
    nz = dsp.svf(rng.uniform(-1, 1, n), 300.0 * (7000.0 / 300.0) ** t, 1.2, "bpn") * t ** 2.0 * 0.55
    rev = dsp.svf(rng.uniform(-1, 1, n), 5000.0, 0.6, "hp") * t ** 4 * 0.35  # reverse-cymbal swell
    f = mtof(40) * 2.0 ** (t * 1.0)  # E2 -> E3
    tone = dsp.svf(dsp.saw(f) + dsp.saw(f * 1.5), 300.0 + 2500 * t ** 2, 0.9, "lp") * t ** 2 * 0.25
    y = nz + rev + tone
    # heartbeat 'lub-dub' at the start of each beat
    beat = dur / 2.0
    for k in range(2):
        for off, g in ((0.0, 0.8), (0.13, 0.55)):
            h = thump(70.0, 40.0, 0.07, 0.2, 1.2) * g
            i = int((k * beat + off) * SR)
            if i < n:
                y[i:i + h.shape[0]] += h[: n - i]
    st = np.stack([y, np.roll(y, int(0.004 * SR))], axis=1)
    return dsp.endfade(st, 6.0)


def vs_impact(**_):
    boom = thump(58.0, 30.0, 0.75, 2.2, 1.7) * 1.0
    body = burst(0.3, 2000.0, 0.6, 0.1, mode="lp", seed=261) * 0.85
    crack = burst(0.06, 3000.0, 1.0, 0.018, seed=262) * 0.7
    cym = burst(2.0, 900.0, 0.6, 0.9, mode="hp", seed=263)
    cym = fx.lp(cym, 9500.0) * 0.18
    drop = tone_sweep(0.6, 300.0, 55.0, "sine", decay=0.25) * 0.35
    return _sum(boom, body, crack, cym, drop)


def name_slam(**_):
    th = thump(125.0, 52.0, 0.08, 0.35) * 0.8
    slap = burst(0.07, 2300.0, 0.8, 0.02, seed=271) * 0.7
    ting = blip(mtof(93), 0.12, 0.05) * 0.12
    return _sum(th, slap, ting)


def sting(**_):
    notes = [45, 52, 57, 64]  # A2 E3 A3 E4 power stack
    b = inst.brass(notes, 0.55, vel=0.95, release=0.5, scoop_cents=120.0, seed=281)
    n = b.shape[0]
    t = np.arange(n) / SR
    swell = np.minimum(t / 0.05, 1.0) * np.exp(-np.maximum(t - 0.25, 0) / 0.35)
    return dsp.endfade(b * swell[:, None]) * 0.55


def fight_slam(**_):
    boom = thump(70.0, 36.0, 0.35, 1.0, 1.6)
    crack = burst(0.06, 3200.0, 1.0, 0.016, seed=291) * 0.7
    body = burst(0.2, 2400.0, 0.6, 0.06, mode="lp", seed=292) * 0.7
    up = noise_sweep(0.25, 800.0, 6000.0, q=1.0, peak_at=0.15, seed=293) * 0.3
    return _sum(boom, crack, body, up)


def bonk(pitch=0.0, seed=0, **_):
    p = _ps(pitch)
    whump = _sum(thump(185.0 * p, 92.0 * p, 0.06, 0.25) * 0.7, burst(0.1, 600.0, 0.7, 0.03, mode="lp", seed=301 + seed) * 0.5)
    wood = burst(0.06, 950.0 * p, 8.0, 0.03, seed=302 + seed) * 0.9
    knock = tone_sweep(0.08, 950.0 * p, 620.0 * p, "sine", decay=0.04) * 0.5
    star = np.concatenate([np.zeros(int(0.05 * SR)), gloss_bell(96 + int(pitch), 0.2, 0.25, decay=0.06)])
    return _sum(whump, wood, knock, to_stereo(star, 0.3))


def hit_heavy(**_):
    th = thump(92.0, 40.0, 0.16, 0.6, 1.8)
    body = burst(0.12, 2500.0, 0.6, 0.05, mode="lp", seed=311) * 0.8
    crack = burst(0.04, 1800.0, 1.1, 0.014, seed=312) * 0.7
    return _sum(th, body, crack)


def ko_impact(**_):
    boom = thump(62.0, 28.0, 0.9, 2.4, 1.9) * 1.0
    crunch = dsp.soft_clip(burst(0.25, 1500.0, 0.5, 0.08, mode="lp", seed=321) * 3.0, 2.5) * 0.35
    crack = burst(0.07, 3400.0, 1.0, 0.02, seed=322) * 0.75
    cym = fx.lp(burst(2.3, 800.0, 0.6, 1.1, mode="hp", seed=323), 9000.0) * 0.22
    drop = tone_sweep(0.5, 420.0, 60.0, "sine", decay=0.25) * 0.4
    return _sum(boom, crunch, crack, cym, drop)


def cut_swish(seed=0, **_):
    return noise_sweep(0.16, 1100.0, 4300.0, q=1.3, peak_at=0.4, pan0=0.4 - 0.2 * (seed % 5), pan1=-0.2, seed=331 + seed) * 0.35


def fact_slam(seed=0, **_):
    th = thump(120.0, 50.0, 0.085, 0.35) * 0.85
    paper = burst(0.06, 2600.0, 0.8, 0.016, seed=341 + seed) * 0.6
    ting = gloss_bell(100, 0.25, 0.12, decay=0.07)
    return _sum(th, paper, to_stereo(ting, 0.25))


def crowd_ooh(**_):
    from .voice import crowd
    return crowd("ooh")


def crowd_cheer(**_):
    from .voice import crowd
    return crowd("cheer")


SFX = {
    "tv_on": tv_on, "box_in": box_in, "whoosh_short": whoosh_short, "sigh_deflate": sigh_deflate,
    "panel_slam": panel_slam, "type_tick": type_tick, "cutin_whoosh": cutin_whoosh, "shing": shing,
    "ransom_slap": ransom_slap, "piik_chirp": piik_chirp, "sparkle": sparkle, "card_fly": card_fly,
    "ui_hover": ui_hover, "ui_click": ui_click, "card_flip": card_flip, "whoosh_up": whoosh_up,
    "stamp": stamp, "ui_confirm": ui_confirm, "card_throw": card_throw, "notif_ding": notif_ding, "pop": pop,
    "riser_short": riser_short, "plop_land": plop_land, "counter_tick": counter_tick, "title_slam": title_slam,
    "danmaku_tick": danmaku_tick, "label_blip": label_blip, "throw_whoosh": throw_whoosh, "splat": splat,
    "poop_boing": poop_boing, "voice_on": voice_on, "request_chime": request_chime, "handover_zap": handover_zap,
    "tension_riser": tension_riser, "vs_impact": vs_impact, "name_slam": name_slam, "sting": sting,
    "fight_slam": fight_slam, "bonk": bonk, "crowd_ooh": crowd_ooh, "hit_heavy": hit_heavy,
    "ko_impact": ko_impact, "crowd_cheer": crowd_cheer, "cut_swish": cut_swish, "fact_slam": fact_slam,
}

# Default level (dB) per sound so the cue sheet only needs relative tweaks.
LEVEL = {
    "tv_on": -4, "box_in": -6, "whoosh_short": -4, "sigh_deflate": -9, "panel_slam": -3, "type_tick": -2,
    "cutin_whoosh": -6, "shing": -8, "ransom_slap": -7, "piik_chirp": -3, "sparkle": -7, "card_fly": -3,
    "ui_hover": -2, "ui_click": -4, "card_flip": -4, "whoosh_up": -4, "stamp": -2, "ui_confirm": -5,
    "card_throw": -1, "notif_ding": -7, "pop": -5, "riser_short": -9, "plop_land": -3, "counter_tick": -6,
    "title_slam": -2, "danmaku_tick": 1, "label_blip": 0, "throw_whoosh": -2, "splat": -4,
    "poop_boing": -6, "voice_on": -5, "request_chime": -6, "handover_zap": -5, "tension_riser": -7,
    "vs_impact": 0, "name_slam": -4, "sting": -5, "fight_slam": -1, "bonk": 1, "crowd_ooh": -6,
    "hit_heavy": -2, "ko_impact": 0, "crowd_cheer": -6, "cut_swish": 2, "fact_slam": -4,
}

# Sounds big enough to dip the music ~2 dB.
BIG = {"tv_on", "panel_slam", "stamp", "title_slam", "vs_impact", "fight_slam", "hit_heavy", "ko_impact",
       "fact_slam", "card_throw", "name_slam", "plop_land", "splat", "handover_zap"}


# Films B / C additions live in sfx_bc.py and are registered here so every film resolves names from one library.
from . import sfx_bc as _bc  # noqa: E402

SFX.update(_bc.SFX_BC)
LEVEL.update(_bc.LEVEL_BC)
BIG |= _bc.BIG_BC
