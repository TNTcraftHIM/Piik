"""SFX added for films B and C. Same family as film A (glossy, rounded, toy-like); B leans clean/editorial UI.

Registered into the shared library at the bottom of sfx.py, so every film resolves names from one place.
Conventions as in sfx.py: t=0 is the cue time (the transient); `dur` = span to an `until` cue; `note` = MIDI;
`pitch` = semitones.
"""
from __future__ import annotations

import math

import numpy as np

from .core import SR, mtof, to_stereo
from . import dsp
from . import fx
from .sfx import _pad, _ps, _r, _sum, blip, burst, crackle, gloss_bell, noise_sweep, thump, tone_sweep

TWO_PI = 2.0 * math.pi


def _place(out, clip, at, pan=0.0, gain=1.0):
    st = to_stereo(clip, pan) * gain if clip.ndim == 1 else clip * gain
    i = int(at * SR)
    if i < out.shape[0]:
        m = min(st.shape[0], out.shape[0] - i)
        out[i:i + m] += st[:m]
    return out


def _span_noise(dur, f0, f1, q0, q1, env, seed, pink=True, pan0=0.0, pan1=0.0):
    """Band-passed noise over a span: centre f0->f1 (exp), Q q0->q1, custom envelope array, decorrelated L/R."""
    rng = _r(seed)
    n = int(dur * SR)
    t = np.arange(n) / max(n, 1)
    fc = f0 * (f1 / f0) ** t
    q = q0 + (q1 - q0) * t
    chans = []
    for c in range(2):
        src = dsp.pink(n, rng) * 3.0 if pink else rng.uniform(-1, 1, n)
        chans.append(dsp.svf(src, fc, q, "bpn") * env)
    pan = pan0 + (pan1 - pan0) * t
    gl = np.cos((pan + 1) * math.pi / 4) * math.sqrt(2)
    gr = np.sin((pan + 1) * math.pi / 4) * math.sqrt(2)
    return np.stack([chans[0] * gl, chans[1] * gr], axis=1) * 0.7


# --------------------------------------------------------------------------------------------------- film B
def pixel_on(**_):
    n = int(0.14 * SR)
    t = np.arange(n) / SR
    y = np.sin(TWO_PI * mtof(98) * t) * np.exp(-t / 0.045) + 0.1 * np.sin(TWO_PI * mtof(110) * t) * np.exp(-t / 0.015)
    y *= np.minimum(t / 0.003, 1.0)
    return to_stereo(dsp.endfade(y) * 0.55)


def label_tick(**_):
    return _sum(burst(0.015, 5200.0, 1.2, 0.0025, seed=501) * 0.45, blip(4100.0, 0.012, 0.003) * 0.2)


def zoom_out(dur=1.0, **_):
    n = int(dur * SR)
    t = np.arange(n) / n
    env = np.where(t < 0.7, (t / 0.7) ** 1.5, 1.0 - 0.75 * (np.clip(t - 0.7, 0.0, None) / 0.3) ** 0.8)
    env *= np.minimum((1 - t) * n / (0.015 * SR), 1.0)
    air = _span_noise(dur, 350.0, 5200.0, 2.5, 0.6, env, 511, pan0=-0.2, pan1=0.2)
    tone = tone_sweep(dur, 220.0, 330.0, "sine", attack=dur * 0.5) * 0.06 * np.minimum((1 - t) * 8, 1.0)
    return _sum(air, tone)


def ui_settle(**_):
    out = np.zeros((int(0.3 * SR), 2))
    _place(out, thump(95.0, 55.0, 0.07, 0.25) * 0.6, 0.0)
    for at, g, s in ((0.015, 0.25, 1), (0.04, 0.2, 2), (0.07, 0.15, 3)):
        _place(out, burst(0.01, 4000.0, 1.2, 0.0025, seed=520 + s), at, 0.15 * s - 0.3, g)
    return out


def panel_slide(**_):
    return noise_sweep(0.24, 900.0, 2400.0, q=1.4, peak_at=0.35, pan0=-0.3, pan1=0.3, seed=531) * 0.5


def tile_tick(note=84, **_):
    return _sum(to_stereo(gloss_bell(note, 0.2, 0.6, ratio=3.0, index=0.5, decay=0.045), 0.1),
                burst(0.008, 4500.0, 1.0, 0.0015, seed=541) * 0.2)


def live_on(**_):
    out = np.zeros((int(0.6 * SR), 2))
    _place(out, gloss_bell(86, 0.4, 0.6, decay=0.2), 0.0, -0.15)
    _place(out, gloss_bell(93, 0.5, 0.65, decay=0.25), 0.09, 0.15)
    return out + _pad(noise_sweep(0.25, 700.0, 3500.0, q=1.0, peak_at=0.5, seed=551) * 0.15, out.shape[0])


def border_draw(dur=1.0, **_):
    n = int(dur * SR)
    t = np.arange(n) / n
    env = np.minimum(t * n / (0.04 * SR), 1.0) * np.minimum((1 - t) * n / (0.05 * SR), 1.0)
    line = _span_noise(dur, 3500.0, 8500.0, 6.0, 6.0, env, 561, pink=False, pan0=-0.7, pan1=0.7)
    whine = tone_sweep(dur, 2400.0, 3600.0, "sine", attack=0.04) * env * 0.05
    return _sum(line * 0.6, whine)


def window_pop(note=72, **_):
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    f = mtof(note) * 2.0 ** (5.0 * np.exp(-t / 0.009) / 12.0)
    ph = np.cumsum(f) / SR
    y = (np.sin(TWO_PI * ph) + 0.2 * np.sin(2 * TWO_PI * ph)) * np.exp(-t / 0.075) * np.minimum(t / 0.0015, 1.0)
    return _sum(dsp.endfade(y) * 0.6, burst(0.008, 3000.0, 1.0, 0.0015, seed=571) * 0.12)


def paste_tick(**_):
    out = np.zeros((int(0.16 * SR), 2))
    for at, g, s in ((0.0, 0.8, 1), (0.07, 1.0, 2)):
        key = _sum(burst(0.014, 2600.0, 1.4, 0.004, seed=580 + s) * 0.5, blip(380.0, 0.025, 0.008) * 0.35)
        _place(out, key, at, 0.0, g)
    return out


def send_whoosh(**_):
    sw = noise_sweep(0.28, 500.0, 5200.0, q=1.1, peak_at=0.6, pan0=-0.2, pan1=0.5, seed=591, shape=1.3) * 0.75
    return _sum(sw, tone_sweep(0.25, 400.0, 1300.0, "sine", decay=0.15) * 0.08)


def chat_pop(**_):
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    f = 520.0 * (880.0 / 520.0) ** np.clip(t / 0.04, 0, 1)
    ph = np.cumsum(f) / SR
    y = (np.sin(TWO_PI * ph) + 0.25 * np.sin(2 * TWO_PI * ph)) * np.exp(-t / 0.055) * np.minimum(t / 0.002, 1.0)
    return _sum(dsp.endfade(y) * 0.6, burst(0.006, 4200.0, 1.0, 0.0012, seed=601) * 0.15)


def check_tick(note=84, **_):
    return _sum(to_stereo(gloss_bell(note, 0.14, 0.5, ratio=2.0, index=0.4, decay=0.03), 0.2),
                burst(0.005, 5000.0, 1.0, 0.001, seed=611) * 0.12)


def draw_sweep(dur=0.5, **_):
    rng = _r(621)
    n = int(dur * SR)
    tt = np.arange(n) / SR
    t = tt / dur
    env = np.minimum(tt / 0.03, 1.0) * np.minimum((dur - tt) / 0.03, 1.0)
    pen = dsp.svf(rng.uniform(-1, 1, n), 1900.0, 3.0, "bpn") * (0.6 + 0.4 * np.sign(np.sin(TWO_PI * 55.0 * tt)))
    servo = np.sin(TWO_PI * np.cumsum(650.0 * (820.0 / 650.0) ** t) / SR) * 0.12
    y = (pen * 0.6 + servo) * env
    pan = -0.3 + 0.6 * t
    return np.stack([y * np.cos((pan + 1) * math.pi / 4), y * np.sin((pan + 1) * math.pi / 4)], axis=1) * 1.2


def seat_fill(note=77, **_):
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    f = mtof(note) * 2.0 ** (-4.0 * np.exp(-t / 0.012) / 12.0)
    ph = np.cumsum(f) / SR
    boop = (np.sin(TWO_PI * ph) + 0.15 * np.sin(2 * TWO_PI * ph)) * np.exp(-t / 0.11) * np.minimum(t / 0.002, 1.0)
    return _sum(thump(130.0, 70.0, 0.05, 0.2) * 0.4, dsp.endfade(boop) * 0.5)


def bitcrush(x, levels=16, hold=6):
    y = np.round(x * levels) / levels
    idx = (np.arange(y.shape[0]) // hold) * hold
    return y[idx]


def edit_glitch(pitch=0.0, seed=0, **_):
    """Comic bad-edit: bit-crushed stutter (5 repeats, stepping down) then a springy boing."""
    p = _ps(pitch)
    out = np.zeros((int(0.6 * SR), 2))
    sl = int(0.026 * SR)
    t = np.arange(sl) / SR
    for k in range(5):
        f = 330.0 * p * 2.0 ** (-k / 12.0)
        s = 0.5 * dsp.pulse(np.full(sl, f), 0.35) + 0.4 * dsp.pulse(np.full(sl, f * 1.335), 0.5)
        s = bitcrush(dsp.svf(s, 3200.0, 0.8, "lp"), 10, 6) * np.minimum(t / 0.001, 1.0)
        s = dsp.endfade(s, 3.0) * (1.0 - 0.1 * k)
        _place(out, s, k * 0.03, 0.3 * (-1) ** k, 0.55)
    n = int(0.34 * SR)
    tb = np.arange(n) / SR
    fb = 262.0 * p * 2.0 ** (1.6 * np.exp(-tb / 0.15) * np.sin(TWO_PI * 13.0 * tb) / 12.0)
    boing = np.sin(TWO_PI * np.cumsum(fb) / SR) * np.exp(-tb / 0.13) * np.minimum(tb / 0.004, 1.0)
    _place(out, dsp.endfade(boing), 0.16, 0.0, 0.45)
    return out


def warn_blip(**_):
    a = blip(mtof(57), 0.07, 0.04, wave="sq")
    b = blip(mtof(53), 0.09, 0.05, wave="sq")
    y = np.concatenate([a, np.zeros(int(0.02 * SR)), b])
    return to_stereo(fx.lp(y, 1800.0) * 0.35, -0.1)


def rainbow_shimmer(**_):
    notes = [72, 76, 79, 82, 84, 88, 91, 94, 96, 100]
    out = np.zeros((int(0.8 * SR), 2))
    for k, nt in enumerate(notes):
        _place(out, gloss_bell(nt, 0.3, 0.45, index=0.5, decay=0.09), 0.028 * k, -0.7 + 1.4 * k / (len(notes) - 1))
    return out + _pad(noise_sweep(0.4, 3000.0, 10000.0, q=1.2, peak_at=0.7, seed=631) * 0.12, out.shape[0])


def control_on(**_):
    rng = _r(641)
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    buzz = dsp.svf(dsp.saw(np.full(n, 180.0) * (1 + 0.2 * rng.uniform(-1, 1, n))), 1200.0, 1.5, "bpn") * np.exp(-t / 0.03)
    rise = tone_sweep(0.4, 400.0, 1600.0, "sine", decay=0.25, attack=0.02)
    glint = np.concatenate([np.zeros(int(0.2 * SR)), gloss_bell(96, 0.3, 0.2, decay=0.08)])
    return _sum(to_stereo(buzz * 0.25), rise * 0.3, burst(0.008, 4200.0, 1.0, 0.0015, seed=642) * 0.25, to_stereo(glint, 0.3))


def rewind(dur=2.0, **_):
    """Tape-rewind texture: reversed-envelope chatter grains + wowing hiss + a rising whine across the span."""
    rng = _r(651)
    n = int(dur * SR)
    out = np.zeros((n, 2))
    t = 0.0
    while t < dur - 0.03:
        g = rng.uniform(0.015, 0.03)
        m = int(g * SR)
        f = rng.uniform(300.0, 1200.0) * (1.0 + 1.5 * t / dur)
        s = dsp.svf(dsp.saw(np.full(m, f)), 1500.0 + 2500.0 * t / dur, 1.2, "bpn")
        s *= np.linspace(0.0, 1.0, m) ** 2  # reversed envelope: swells then cuts
        s = dsp.endfade(s, 1.5)
        _place(out, s, t, float(rng.uniform(-0.5, 0.5)), 0.5)
        t += g + rng.uniform(0.003, 0.012)
    tt = np.arange(n) / SR
    hiss = dsp.svf(dsp.pink(n, rng) * 3.0, 3800.0, 0.8, "bpn") * (0.75 + 0.25 * np.sin(TWO_PI * 6.0 * tt)) * 0.2
    whine = np.sin(TWO_PI * np.cumsum(600.0 * 4.0 ** (tt / dur)) / SR) * 0.04
    out += np.stack([hiss + whine, np.roll(hiss, 23) + whine], axis=1)
    out *= np.minimum(tt / 0.02, 1.0)[:, None]
    return dsp.endfade(out, 10.0)


def undo_tick(note=72, **_):
    return _sum(to_stereo(gloss_bell(note, 0.16, 0.7, ratio=3.0, index=0.8, decay=0.04), -0.1),
                burst(0.006, 6000.0, 1.0, 0.0012, mode="hp", seed=661) * 0.3)


def clock_tick(**_):
    return _sum(burst(0.03, 2800.0, 6.0, 0.006, seed=671) * 0.6, burst(0.01, 6000.0, 1.0, 0.002, mode="hp", seed=672) * 0.2)


def select_tick(**_):
    return _sum(burst(0.012, 4000.0, 0.8, 0.002, mode="hp", seed=681) * 0.35, blip(1700.0, 0.025, 0.008) * 0.35,
                to_stereo(gloss_bell(100, 0.22, 0.18, decay=0.06), 0.25))


def zoom_in(dur=1.0, **_):
    n = int(dur * SR)
    t = np.arange(n) / n
    env = t ** 1.8 * np.minimum((1 - t) * n / (0.012 * SR), 1.0)
    air = _span_noise(dur, 6000.0, 380.0, 1.0, 1.0, env, 691, pan0=0.3, pan1=0.0)
    down = tone_sweep(dur, 900.0, 160.0, "sine", attack=dur * 0.3) * env * 0.08
    return _sum(air, down)


def drag_tick(**_):
    return _sum(blip(4200.0, 0.012, 0.003) * 0.5, burst(0.006, 7000.0, 1.0, 0.0015, mode="hp", seed=701) * 0.3)


def snap(**_):
    """THE moment: crisp magnetic latch (double click + woody thock), weight, and a bright Fmaj9 bell bloom."""
    out = np.zeros((int(2.2 * SR), 2))
    crack = _sum(burst(0.02, 3500.0, 0.8, 0.0035, seed=711) * 0.9,
                 burst(0.004, 9000.0, 0.7, 0.0008, mode="hp", seed=712) * 0.5,
                 blip(1800.0, 0.03, 0.008) * 0.45)
    _place(out, crack, 0.0)
    _place(out, burst(0.012, 5200.0, 1.2, 0.002, seed=713) * 0.5, 0.009, 0.1)       # latch second click
    _place(out, thump(160.0, 90.0, 0.035, 0.15, 1.2) * 0.55, 0.0)                   # woody thock
    _place(out, thump(80.0, 42.0, 0.25, 0.9, 1.3) * 0.45, 0.0)                      # weight
    for k, nt in enumerate((89, 93, 96, 100, 103)):                                 # F6 A6 C7 E7 G7 strum up
        _place(out, gloss_bell(nt, 1.4, 0.55 - 0.05 * k, ratio=3.0, index=0.6, decay=0.75 - 0.08 * k),
               0.012 * (k + 1), -0.6 + 0.3 * k)
    tail = noise_sweep(1.1, 6000.0, 10000.0, q=1.4, peak_at=0.08, pan0=-0.5, pan1=0.5, seed=714, shape=0.6) * 0.1
    _place(out, tail, 0.015)
    return out


def zoom_out_short(dur=0.75, **_):
    n = int(dur * SR)
    t = np.arange(n) / n
    env = np.where(t < 0.25, t / 0.25, (1 - (t - 0.25) / 0.75) ** 1.4) * np.minimum((1 - t) * n / (0.01 * SR) + 1e-9, 1.0)
    return _span_noise(dur, 1800.0, 6500.0, 1.6, 0.7, env, 721, pan0=-0.2, pan1=0.3)


def tile_flip(seed=0, **_):
    f1 = burst(0.03, 3300.0, 1.2, 0.006, seed=731 + seed) * 0.5
    f2 = np.concatenate([np.zeros(int(0.025 * SR)), burst(0.03, 3800.0, 1.2, 0.006, seed=732 + seed) * 0.4])
    tone = tone_sweep(0.05, 1200.0, 1800.0, "sine", decay=0.02) * 0.2
    return _sum(f1, f2, tone)


def row_decode(seed=0, **_):
    rng = _r(741 + seed)
    out = np.zeros((int(0.22 * SR), 2))
    t = 0.0
    while t < 0.14:
        b = blip(float(rng.uniform(800.0, 3200.0)), 0.008, 0.004, wave="sq") * float(rng.uniform(0.15, 0.3))
        _place(out, b, t, float(rng.uniform(-0.4, 0.4)))
        t += 0.008 + float(rng.uniform(0.002, 0.005))
    out = fx.lp(out, 6000.0)
    end = _sum(burst(0.012, 4200.0, 0.8, 0.002, mode="hp", seed=742 + seed) * 0.4, blip(1900.0, 0.03, 0.008) * 0.35)
    return _place(out, end, 0.15)


def zoom_in_soft(dur=1.0, **_):
    n = int(dur * SR)
    t = np.arange(n) / n
    env = np.where(t < 0.7, (t / 0.7) ** 1.3, (1 - (t - 0.7) / 0.3) ** 1.2) * np.minimum((1 - t) * n / (0.01 * SR) + 1e-9, 1.0)
    return _span_noise(dur, 3200.0, 900.0, 0.9, 0.9, env, 751) * 0.7


# --------------------------------------------------------------------------------------------------- film C
def text_pop(seed=0, **_):
    n = int(0.11 * SR)
    t = np.arange(n) / SR
    f = 480.0 * (820.0 / 480.0) ** np.clip(t / 0.03, 0, 1)
    ph = np.cumsum(f) / SR
    y = (np.sin(TWO_PI * ph) + 0.2 * np.sin(2 * TWO_PI * ph)) * np.exp(-t / 0.05) * np.minimum(t / 0.002, 1.0)
    out = np.zeros((int(0.16 * SR), 2))
    _place(out, dsp.endfade(y) * 0.55, 0.0)
    _place(out, blip(1250.0, 0.04, 0.012) * 0.22, 0.035, 0.2)
    return out


def pop_friend(note=72, seed=0, **_):
    """THE key sound of film C: a round 'bloop' rising into the note + a tiny cushion squish; stays sweet up to
    MIDI 100 (upper partials thin out as the pitch rises). Pans along the sofa with pitch."""
    f0 = mtof(note)
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    f = f0 * 2.0 ** (-3.2 * np.exp(-t / 0.016) / 12.0)
    ph = np.cumsum(f) / SR
    hi = float(np.clip((note - 72) / 28.0, 0.0, 1.0))
    body = (np.sin(TWO_PI * ph) + (0.24 - 0.14 * hi) * np.sin(2 * TWO_PI * ph) * np.exp(-t / 0.06)
            + (0.05 - 0.04 * hi) * np.sin(3 * TWO_PI * ph) * np.exp(-t / 0.03))
    decay = 0.15 - 0.06 * hi
    body *= np.exp(-t / decay) * np.minimum(t / 0.0025, 1.0)
    sparkle = np.sin(TWO_PI * ph + 0.8 * np.exp(-t / 0.006) * np.sin(TWO_PI * 2.0 * ph)) * np.exp(-t / 0.012) * 0.25
    squish = burst(0.06, 900.0 * (f0 / 523.0) ** 0.3, 0.7, 0.018, mode="lp", seed=801 + seed) * (0.35 - 0.2 * hi)
    cushion = thump(150.0, 85.0, 0.03, 0.12, 1.1) * (0.3 - 0.22 * hi)
    pan = float(np.clip(-0.55 + 1.1 * hi, -0.55, 0.55))
    return _sum(to_stereo(dsp.endfade(body + sparkle) * 0.62, pan), to_stereo(squish, pan), to_stereo(cushion, pan))


def impact_big(**_):
    boom = thump(62.0, 34.0, 0.45, 1.6, 1.6) * 0.95
    body = burst(0.15, 6000.0, 0.6, 0.04, mode="lp", seed=811) * 0.55
    cym = fx.lp(burst(1.6, 900.0, 0.6, 0.7, mode="hp", seed=812), 9500.0) * 0.22
    ting = to_stereo(gloss_bell(96, 0.6, 0.4, decay=0.3), 0.2)
    return _sum(boom, body, cym, ting)


def firework_pop(note=84, seed=0, **_):
    rng = _r(821 + seed)
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    f = mtof(note) * 2.0 ** (-2.5 * np.exp(-t / 0.01) / 12.0)
    ph = np.cumsum(f) / SR
    pop = (np.sin(TWO_PI * ph) + 0.12 * np.sin(2 * TWO_PI * ph)) * np.exp(-t / 0.09) * np.minimum(t / 0.002, 1.0)
    out = np.zeros((int(0.7 * SR), 2))
    _place(out, dsp.endfade(pop) * 0.55, 0.0, float(rng.uniform(-0.3, 0.3)))
    for k in range(9):
        nt = note + int(rng.choice([12, 14, 16, 19, 21, 24]))
        if nt > 108:
            nt -= 12
        _place(out, gloss_bell(nt, 0.2, 0.28 * (1 - k / 11), index=0.4, decay=0.05), 0.05 + 0.045 * k + rng.uniform(0, 0.02),
               float(rng.uniform(-0.8, 0.8)))
    crk = crackle(0.45, 160.0, 6500.0, seed=822 + seed) * np.exp(-np.arange(int(0.45 * SR)) / SR / 0.18) * 0.5
    return _place(out, to_stereo(crk), 0.04)


def text_slam(pitch=0.0, seed=0, **_):
    th = thump(120.0, 50.0, 0.08, 0.35) * 0.85
    slap = burst(0.06, 2300.0, 0.8, 0.016, seed=831 + seed) * 0.55
    tick = to_stereo(gloss_bell(96 + pitch, 0.2, 0.5, ratio=3.0, index=0.6, decay=0.05), 0.15)
    return _sum(th, slap, tick)


SFX_BC = {
    "pixel_on": pixel_on, "label_tick": label_tick, "zoom_out": zoom_out, "ui_settle": ui_settle,
    "panel_slide": panel_slide, "tile_tick": tile_tick, "live_on": live_on, "border_draw": border_draw,
    "window_pop": window_pop, "paste_tick": paste_tick, "send_whoosh": send_whoosh, "chat_pop": chat_pop,
    "check_tick": check_tick, "draw_sweep": draw_sweep, "seat_fill": seat_fill, "edit_glitch": edit_glitch,
    "warn_blip": warn_blip, "rainbow_shimmer": rainbow_shimmer, "control_on": control_on, "rewind": rewind,
    "undo_tick": undo_tick, "clock_tick": clock_tick, "select_tick": select_tick, "zoom_in": zoom_in,
    "drag_tick": drag_tick, "snap": snap, "zoom_out_short": zoom_out_short, "tile_flip": tile_flip,
    "row_decode": row_decode, "zoom_in_soft": zoom_in_soft,
    "text_pop": text_pop, "pop_friend": pop_friend, "impact_big": impact_big, "firework_pop": firework_pop,
    "text_slam": text_slam,
}
LEVEL_BC = {
    "pixel_on": -8, "label_tick": -8, "zoom_out": -8, "ui_settle": -6, "panel_slide": -6, "tile_tick": -7,
    "live_on": -5, "border_draw": -12, "window_pop": -5, "paste_tick": -6, "send_whoosh": -5, "chat_pop": -5,
    "check_tick": -8, "draw_sweep": -10, "seat_fill": -5, "edit_glitch": -4, "warn_blip": -9,
    "rainbow_shimmer": -7, "control_on": -5, "rewind": -11, "undo_tick": -6, "clock_tick": -9,
    "select_tick": -6, "zoom_in": -7, "drag_tick": -6, "snap": -1, "zoom_out_short": -8, "tile_flip": -5,
    "row_decode": -6, "zoom_in_soft": -10,
    "text_pop": -6, "pop_friend": -3, "impact_big": -1, "firework_pop": -5, "text_slam": -3,
}
BIG_BC = {"edit_glitch", "impact_big", "text_slam"}
