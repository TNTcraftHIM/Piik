"""Synthesised drum kit: rounded, punchy, never fizzy (every noisy voice is low-passed below ~12 kHz)."""
from __future__ import annotations

import math

import numpy as np

from .core import SR, mtof
from . import dsp
from . import fx

_RNG = np.random.default_rng(1234)


def _rng(seed):
    return np.random.default_rng(seed) if seed is not None else _RNG


def kick(vel=1.0, decay=0.22, f_hi=170.0, f_lo=50.0, drive=1.6, click=0.7, seed=None):
    n = int(0.55 * SR)
    t = dsp.tvec(n)
    f = f_lo + (f_hi - f_lo) * np.exp(-t / 0.035)
    body = np.sin(2 * math.pi * np.cumsum(f) / SR)
    env = np.exp(-np.maximum(t - 0.008, 0) / decay)
    body *= env
    rng = _rng(seed)
    nc = int(0.006 * SR)
    clk = dsp.svf(rng.uniform(-1, 1, nc), 3500.0, 0.8, "bp") * np.exp(-np.arange(nc) / (0.0012 * SR))
    clk2 = np.sin(2 * math.pi * 1400 * np.arange(nc) / SR) * np.exp(-np.arange(nc) / (0.002 * SR))
    body[:nc] += click * (0.6 * clk + 0.35 * clk2)
    out = dsp.soft_clip(body * 0.9, drive) * vel
    return dsp.normalize_peak(out, vel) if vel > 0 else out


def snare(vel=1.0, tone=196.0, snappy=0.8, decay=0.16, seed=None):
    rng = _rng(seed)
    n = int(0.42 * SR)
    t = dsp.tvec(n)
    f1 = tone + 55.0 * np.exp(-t / 0.012)
    b1 = np.sin(2 * math.pi * np.cumsum(f1) / SR) * np.exp(-t / 0.075)
    b2 = np.sin(2 * math.pi * np.cumsum(f1 * 1.74) / SR) * np.exp(-t / 0.05) * 0.5
    nz = rng.uniform(-1, 1, n)
    nz = dsp.svf(nz, 1300.0, 0.6, "hp")
    nz = dsp.svf(nz, 8500.0, 0.6, "lp")
    nz *= np.exp(-t / (decay * (0.6 + 0.4 * vel)))
    snap = np.zeros(n)
    k = int(0.0015 * SR)
    snap[:k] = rng.uniform(-1, 1, k) * np.linspace(1, 0, k)
    out = 0.75 * (b1 + b2) + snappy * 0.9 * nz + 0.4 * snap
    out = dsp.soft_clip(out * 0.8, 1.3)
    out = dsp.endfade(out)
    return dsp.normalize_peak(out, vel)


def rim(vel=1.0, seed=None):
    rng = _rng(seed)
    n = int(0.08 * SR)
    t = dsp.tvec(n)
    body = np.sin(2 * math.pi * 820 * t) * np.exp(-t / 0.012)
    nz = dsp.svf(rng.uniform(-1, 1, n), 1800.0, 3.0, "bpn") * np.exp(-t / 0.008)
    return dsp.normalize_peak(0.6 * body + 0.8 * nz, vel)


def clap(vel=1.0, seed=None):
    rng = _rng(seed)
    n = int(0.35 * SR)
    t = dsp.tvec(n)
    nz = dsp.svf(rng.uniform(-1, 1, n), 1150.0, 1.4, "bpn")
    env = np.zeros(n)
    for k, off in enumerate((0.0, 0.009, 0.018, 0.028)):
        i0 = int(off * SR)
        tt = t[: n - i0]
        env[i0:] = np.maximum(env[i0:], np.exp(-tt / 0.006) * (0.75 + 0.08 * k))
    tail_start = int(0.028 * SR)
    env[tail_start:] = np.maximum(env[tail_start:], 0.8 * np.exp(-(t[: n - tail_start]) / 0.11))
    out = nz * env
    out = fx.lp(out, 9000.0)
    return dsp.normalize_peak(out, vel)


_HAT_FREQS = np.array([205.3, 304.4, 369.6, 522.7, 540.0, 800.0]) * 1.65


def _metal(n, rng, freqs=_HAT_FREQS):
    t = dsp.tvec(n)
    m = np.zeros(n)
    for f in freqs:
        ph = rng.uniform(0, 1)
        m += np.sign(np.sin(2 * math.pi * (f * t + ph)))
    return m / len(freqs)


def hat(vel=1.0, decay=0.035, open_=False, seed=None):
    rng = _rng(seed)
    dur = 0.6 if open_ else 0.12
    n = int(dur * SR)
    t = dsp.tvec(n)
    src = 0.55 * _metal(n, rng) + 0.45 * rng.uniform(-1, 1, n)
    src = dsp.svf(src, 7200.0, 0.9, "hp")
    src = dsp.svf(src, 11500.0, 0.7, "lp")
    d = 0.32 if open_ else decay
    env = np.exp(-t / d)
    env[: int(0.0008 * SR)] *= np.linspace(0, 1, int(0.0008 * SR))
    out = dsp.endfade(src * env)
    return dsp.normalize_peak(out, vel)


def shaker(vel=1.0, seed=None):
    rng = _rng(seed)
    n = int(0.12 * SR)
    t = dsp.tvec(n)
    nz = dsp.svf(rng.uniform(-1, 1, n), 6200.0, 1.2, "bpn")
    env = np.minimum(t / 0.012, 1.0) * np.exp(-np.maximum(t - 0.012, 0) / 0.035)
    return dsp.normalize_peak(fx.lp(nz * env, 11000.0), vel)


def ride(vel=1.0, bell=0.3, seed=None):
    rng = _rng(seed)
    n = int(1.6 * SR)
    t = dsp.tvec(n)
    m = _metal(n, rng, _HAT_FREQS * 0.8)
    m = dsp.svf(m, 5200.0, 2.0, "bpn")
    nz = dsp.svf(rng.uniform(-1, 1, n), 6500.0, 0.7, "hp")
    out = (0.6 * m + 0.25 * nz) * np.exp(-t / 0.55)
    bl = sum(np.sin(2 * math.pi * f * t) for f in (1580.0, 2370.0, 3410.0)) * np.exp(-t / 0.35)
    out += bell * 0.3 * bl
    out = fx.lp(out, 11000.0)
    out = dsp.endfade(out)
    return dsp.normalize_peak(out, vel)


def crash(vel=1.0, dur=2.6, seed=None):
    rng = _rng(seed)
    n = int(dur * SR)
    t = dsp.tvec(n)
    chans = []
    for c in range(2):
        nz = rng.uniform(-1, 1, n)
        m = _metal(n, rng, _HAT_FREQS * (0.9 + 0.07 * c))
        src = 0.7 * nz + 0.35 * m
        src = dsp.svf(src, 420.0, 0.7, "hp")
        src = dsp.svf(src, 10500.0, 0.6, "lp")
        env = np.exp(-t / 0.75) * (0.75 + 0.25 * np.exp(-t / 0.08))
        env[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
        chans.append(src * env)
    out = np.stack(chans, axis=1)
    out = dsp.endfade(out)
    return dsp.normalize_peak(out, vel)


def tom(note=45, vel=1.0, decay=0.26, seed=None):
    rng = _rng(seed)
    f0 = mtof(note)
    n = int((decay * 3 + 0.05) * SR)
    t = dsp.tvec(n)
    f = f0 * (1.0 + 0.55 * np.exp(-t / 0.03))
    body = np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    nz = dsp.svf(rng.uniform(-1, 1, n), f0 * 6, 1.0, "bpn") * np.exp(-t / 0.02)
    out = dsp.soft_clip(body + 0.25 * nz, 1.4)
    out = dsp.endfade(out)
    return dsp.normalize_peak(out, vel)


def timpani(note=33, vel=1.0, seed=None):
    """Big low orchestral-ish hit used under 'VS'/'K.O.' style impacts."""
    rng = _rng(seed)
    f0 = mtof(note)
    n = int(1.4 * SR)
    t = dsp.tvec(n)
    # kettle-drum-like partials; the 4th is tuned to a minor tenth (2.38) so hits sit inside minor keys
    partials = [(1.0, 1.0, 0.7), (1.5, 0.45, 0.45), (1.99, 0.3, 0.35), (2.38, 0.18, 0.25)]
    out = np.zeros(n)
    for r, a, d in partials:
        f = f0 * r * (1 + 0.04 * np.exp(-t / 0.05))
        out += a * np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t / d)
    nz = dsp.svf(rng.uniform(-1, 1, n), 400.0, 0.8, "lp") * np.exp(-t / 0.05)
    out = dsp.soft_clip(out + 0.6 * nz, 1.2)
    out = dsp.endfade(out)
    return dsp.normalize_peak(out, vel)
