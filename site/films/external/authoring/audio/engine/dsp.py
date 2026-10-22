"""Low-level DSP: band-limited oscillators, modulated state-variable filter, envelopes, noise, Karplus-Strong.

Everything works on float64 numpy arrays at core.SR. Per-sample parameters (frequency, cutoff) are arrays so
glides, vibrato and filter envelopes are sample accurate. Hot loops are numba-compiled.
"""
from __future__ import annotations

import math

import numpy as np
from numba import njit

from .core import SR

TWO_PI = 2.0 * math.pi


# ----------------------------------------------------------------------------------------------- oscillators
@njit(cache=True)
def _blep(t, dt):
    if t < dt:
        t = t / dt
        return t + t - t * t - 1.0
    if t > 1.0 - dt:
        t = (t - 1.0) / dt
        return t * t + t + t + 1.0
    return 0.0


@njit(cache=True)
def _saw(freq, sr, phase):
    n = freq.shape[0]
    out = np.empty(n)
    ph = phase
    for i in range(n):
        dt = freq[i] / sr
        if dt > 0.5:
            dt = 0.5
        out[i] = 2.0 * ph - 1.0 - _blep(ph, dt)
        ph += dt
        if ph >= 1.0:
            ph -= 1.0
    return out


@njit(cache=True)
def _pulse(freq, pw, sr, phase):
    n = freq.shape[0]
    out = np.empty(n)
    ph = phase
    for i in range(n):
        dt = freq[i] / sr
        if dt > 0.5:
            dt = 0.5
        w = pw[i]
        v = 1.0 if ph < w else -1.0
        v += _blep(ph, dt)
        t2 = ph + (1.0 - w)
        if t2 >= 1.0:
            t2 -= 1.0
        v -= _blep(t2, dt)
        out[i] = v
        ph += dt
        if ph >= 1.0:
            ph -= 1.0
    return out


def _arr(v, n):
    if np.isscalar(v):
        return np.full(n, float(v))
    return np.asarray(v, dtype=np.float64)


def saw(freq, n=None, phase=0.0):
    f = _arr(freq, n) if n else np.asarray(freq, dtype=np.float64)
    return _saw(f, float(SR), float(phase))


def pulse(freq, pw=0.5, n=None, phase=0.0):
    f = _arr(freq, n) if n else np.asarray(freq, dtype=np.float64)
    return _pulse(f, _arr(pw, f.shape[0]), float(SR), float(phase))


def phase_of(freq, n=None, phase=0.0):
    """Cumulative phase in cycles for a (possibly time-varying) frequency."""
    f = _arr(freq, n) if n else np.asarray(freq, dtype=np.float64)
    return phase + np.cumsum(f) / SR - f / SR


def sine(freq, n=None, phase=0.0):
    return np.sin(TWO_PI * phase_of(freq, n, phase))


def triangle(freq, n=None, phase=0.0):
    ph = phase_of(freq, n, phase) % 1.0
    return 4.0 * np.abs(ph - 0.5) - 1.0


def fm(carrier_freq, mod, index, n=None, phase=0.0):
    """Phase modulation operator: sin(2π∫fc + index·mod)."""
    return np.sin(TWO_PI * phase_of(carrier_freq, n, phase) + np.asarray(index) * mod)


# ---------------------------------------------------------------------------------------------------- noise
def white(n, rng):
    return rng.uniform(-1.0, 1.0, n)


@njit(cache=True)
def _pinkify(w):
    b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0
    out = np.empty(w.shape[0])
    for i in range(w.shape[0]):
        x = w[i]
        b0 = 0.99886 * b0 + x * 0.0555179
        b1 = 0.99332 * b1 + x * 0.0750759
        b2 = 0.96900 * b2 + x * 0.1538520
        b3 = 0.86650 * b3 + x * 0.3104856
        b4 = 0.55000 * b4 + x * 0.5329522
        b5 = -0.7616 * b5 - x * 0.0168980
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11
        b6 = x * 0.115926
    return out


def pink(n, rng):
    return _pinkify(rng.uniform(-1.0, 1.0, n))


# -------------------------------------------------------------------------------------------------- filters
@njit(cache=True)
def _svf(x, cutoff, q, sr, mode):
    """Zavalishin TPT state-variable filter. mode 0=LP 1=BP 2=HP 3=notch 4=BP normalised (peak gain 1)."""
    n = x.shape[0]
    out = np.empty(n)
    ic1 = 0.0
    ic2 = 0.0
    nyq = 0.49 * sr
    for i in range(n):
        fc = cutoff[i]
        if fc < 10.0:
            fc = 10.0
        if fc > nyq:
            fc = nyq
        g = math.tan(math.pi * fc / sr)
        k = 1.0 / q[i]
        a1 = 1.0 / (1.0 + g * (g + k))
        a2 = g * a1
        a3 = g * a2
        v3 = x[i] - ic2
        v1 = a1 * ic1 + a2 * v3
        v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2.0 * v1 - ic1
        ic2 = 2.0 * v2 - ic2
        if mode == 0:
            out[i] = v2
        elif mode == 1:
            out[i] = v1
        elif mode == 2:
            out[i] = x[i] - k * v1 - v2
        elif mode == 3:
            out[i] = x[i] - k * v1
        else:
            out[i] = k * v1
    return out


_MODES = {"lp": 0, "bp": 1, "hp": 2, "notch": 3, "bpn": 4}


def svf(x, cutoff, q=0.707, mode="lp"):
    """Modulated SVF. cutoff/q may be scalars or per-sample arrays. Works on mono or stereo input."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        return np.stack([svf(x[:, c], cutoff, q, mode) for c in range(x.shape[1])], axis=1)
    n = x.shape[0]
    return _svf(x, _arr(cutoff, n), _arr(q, n), float(SR), _MODES[mode])


@njit(cache=True)
def _onepole(x, coef):
    out = np.empty(x.shape[0])
    y = 0.0
    for i in range(x.shape[0]):
        y += coef * (x[i] - y)
        out[i] = y
    return out


def onepole_lp(x, fc):
    coef = 1.0 - math.exp(-TWO_PI * fc / SR)
    if x.ndim == 2:
        return np.stack([_onepole(x[:, c].copy(), coef) for c in range(2)], axis=1)
    return _onepole(np.asarray(x, dtype=np.float64), coef)


def onepole_hp(x, fc):
    return x - onepole_lp(x, fc)


@njit(cache=True)
def _dcblock(x, r):
    out = np.empty(x.shape[0])
    xm = 0.0
    ym = 0.0
    for i in range(x.shape[0]):
        y = x[i] - xm + r * ym
        xm = x[i]
        ym = y
        out[i] = y
    return out


def dc_block(x, r=0.9995):
    if x.ndim == 2:
        return np.stack([_dcblock(x[:, c].copy(), r) for c in range(x.shape[1])], axis=1)
    return _dcblock(np.asarray(x, dtype=np.float64), r)


# ------------------------------------------------------------------------------------------------ envelopes
def tvec(n):
    return np.arange(n) / SR


def adsr(gate_s, a=0.005, d=0.1, s=0.7, r=0.1, curve=4.0):
    """ADSR as an array of length gate+release. Decay/release are exponential (≈ -curve·τ by the end)."""
    ng = max(1, int(round(gate_s * SR)))
    na = max(1, int(round(a * SR)))
    nr = max(1, int(round(r * SR)))
    env = np.empty(ng + nr)
    t = np.arange(ng)
    att = np.minimum(t / na, 1.0)
    att = 1.0 - (1.0 - att) ** 2  # slightly convex attack
    td = np.maximum(t - na, 0) / SR
    dec = s + (1.0 - s) * np.exp(-td * curve / max(d, 1e-4))
    env[:ng] = np.where(t < na, att, dec)
    last = env[ng - 1]
    tr = np.arange(nr) / SR
    rel = last * np.exp(-tr * curve / r)
    rel *= np.linspace(1.0, 0.0, nr) ** 0.5  # guarantee exact zero at the end
    env[ng:] = rel
    return env


def perc(dur, a=0.001, decay=0.2, curve=1.0):
    """Attack + exponential decay with time-constant `decay` seconds, total length `dur`."""
    n = max(1, int(round(dur * SR)))
    t = np.arange(n) / SR
    na = max(1, int(round(a * SR)))
    env = np.exp(-t / max(decay, 1e-4)) ** curve
    env[:na] *= np.linspace(0.0, 1.0, na)
    tail = min(n, int(0.004 * SR))
    env[n - tail:] *= np.linspace(1.0, 0.0, tail)
    return env


def endfade(x, ms=4.0, start_ms=0.0):
    """Short fade-in (start_ms) and fade-out (ms) applied in place-safe copy; works for mono or stereo."""
    y = np.array(x, dtype=np.float64, copy=True)
    n = y.shape[0]
    k = min(n, max(1, int(ms / 1000.0 * SR)))
    w = np.linspace(1.0, 0.0, k)
    y[n - k:] = (y[n - k:].T * w).T
    if start_ms > 0:
        k0 = min(n, max(1, int(start_ms / 1000.0 * SR)))
        w0 = np.linspace(0.0, 1.0, k0)
        y[:k0] = (y[:k0].T * w0).T
    return y


def expseg(n, v0, v1):
    """Exponential interpolation from v0 to v1 (both > 0) over n samples."""
    return v0 * (v1 / v0) ** (np.arange(n) / max(n - 1, 1))


def glide(n, f_from, f_to, time_s):
    """Exponential pitch glide from f_from to f_to in time_s, then hold."""
    k = max(1, int(time_s * SR))
    out = np.full(n, float(f_to))
    m = min(k, n)
    out[:m] = f_from * (f_to / f_from) ** (np.arange(m) / k)
    return out


def vibrato(n, rate=5.5, cents=15.0, delay=0.15, rise=0.2, phase=0.0):
    """Frequency multiplier with delayed-onset vibrato."""
    t = np.arange(n) / SR
    depth = np.clip((t - delay) / max(rise, 1e-3), 0.0, 1.0) * cents
    return 2.0 ** (depth * np.sin(TWO_PI * rate * t + phase) / 1200.0)


# ------------------------------------------------------------------------------------------ Karplus-Strong
@njit(cache=True)
def _ks(excite, n, delay, fb, damp):
    size = int(delay) + 4
    buf = np.zeros(size)
    out = np.empty(n)
    w = 0
    lp = 0.0
    ne = excite.shape[0]
    for i in range(n):
        rp = w - delay
        while rp < 0:
            rp += size
        i0 = int(rp)
        fr = rp - i0
        i1 = i0 + 1
        if i1 >= size:
            i1 -= size
        d = buf[i0] * (1.0 - fr) + buf[i1] * fr
        lp = lp + damp * (d - lp)
        x = excite[i] if i < ne else 0.0
        y = x + fb * lp
        buf[w] = y
        out[i] = y
        w += 1
        if w >= size:
            w = 0
    return out


def karplus(freq, dur, rng, fb=0.996, damp=0.5, bright=0.6, excite_ms=6.0):
    """Plucked string. fb sets sustain, damp (0..1) sets loop brightness, bright sets pick brightness."""
    n = int(dur * SR)
    ne = max(8, int(excite_ms / 1000.0 * SR))
    ex = rng.uniform(-1.0, 1.0, ne)
    ex = onepole_lp(ex, 800.0 + 9000.0 * bright)
    ex *= np.hanning(ne * 2)[ne:] ** 0.5
    # one-pole loop filter adds ~ (1-damp)/damp samples of delay; compensate for tuning
    loop_delay = (1.0 - damp) / max(damp, 1e-3)
    delay = SR / freq - loop_delay
    return _ks(ex, n, max(delay, 2.0), fb, damp)


# --------------------------------------------------------------------------------------------- saturation
def soft_clip(x, drive=1.0):
    if drive <= 0:
        return x
    return np.tanh(x * drive) / math.tanh(drive)


def normalize_peak(x, peak=1.0):
    m = np.max(np.abs(x))
    return x if m < 1e-12 else x * (peak / m)
