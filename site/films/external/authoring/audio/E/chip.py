"""Film E chiptune voices: band-limited pulse (12.5/25/50 %), stepped 4-bit triangle, 15-bit LFSR noise drums.

Volume envelopes are quantised to 16 steps and the triangle to 16 levels for an authentic console flavour,
while PolyBLEP keeps the pulse channels clean at 48 kHz. All functions return mono float64 arrays.
"""
from __future__ import annotations

import numpy as np
from numba import njit

from engine.core import SR, mtof
from engine import dsp


def _n(sec):
    return max(1, int(round(sec * SR)))


def pulse_note(note, dur, duty=0.25, vol=0.5, a=0.002, d=0.09, s=0.55, r=0.03, vib=0.0, vib_rate=6.2,
               vib_delay=0.14, slide=0.0, slide_t=0.025, arp=None, arp_hz=60.0, steps=True, bend_to=None):
    """One pulse-channel note. slide: start that many semitones away and settle; arp: semitone offsets cycled at arp_hz;
    bend_to: glide linearly (in semitones) to this MIDI note across the note."""
    env = dsp.adsr(dur, a, d, s, r)
    n = env.shape[0]
    semi = np.full(n, float(note))
    if slide:
        semi += slide * np.exp(-np.arange(n) / (slide_t * SR))
    if bend_to is not None:
        semi += (bend_to - note) * np.clip(np.arange(n) / _n(dur), 0.0, 1.0)
    if arp:
        idx = (np.arange(n) * arp_hz / SR).astype(np.int64) % len(arp)
        semi += np.asarray(arp, dtype=np.float64)[idx]
    f = 440.0 * 2.0 ** ((semi - 69.0) / 12.0)
    if vib:
        f *= dsp.vibrato(n, vib_rate, vib, vib_delay, 0.12)
    y = dsp.pulse(f, duty, n)
    if steps:
        env = np.round(env * 15.0) / 15.0
    return dsp.endfade(y * env * vol, 3.0)


def tri_note(note, dur, vol=0.9, r=0.015, slide=0.0, bend_to=None):
    """Stepped triangle (16 levels, constant volume like the console channel) with a short release."""
    n = _n(dur + r)
    semi = np.full(n, float(note))
    if slide:
        semi += slide * np.exp(-np.arange(n) / (0.02 * SR))
    if bend_to is not None:
        semi += (bend_to - note) * np.clip(np.arange(n) / _n(dur), 0.0, 1.0)
    f = 440.0 * 2.0 ** ((semi - 69.0) / 12.0)
    ph = (np.cumsum(f) / SR) % 1.0
    tri = 4.0 * np.abs(ph - 0.5) - 1.0
    tri = np.round((tri + 1.0) * 7.5) / 7.5 - 1.0
    env = np.ones(n)
    k = _n(r)
    env[n - k:] = np.linspace(1.0, 0.0, k)
    env[: _n(0.002)] = np.linspace(0.0, 1.0, _n(0.002))
    return tri * env * vol


@njit(cache=True)
def _lfsr(n, period, short):
    out = np.empty(n)
    reg = 1
    acc = 0.0
    v = 1.0
    tap = 6 if short else 1
    for i in range(n):
        acc += 1.0
        while acc >= period:
            acc -= period
            bit = (reg ^ (reg >> tap)) & 1
            reg = (reg >> 1) | (bit << 14)
            v = 1.0 if (reg & 1) else -1.0
        out[i] = v
    return out


def noise(dur, rate_hz, short=False):
    return _lfsr(_n(dur), max(1.0, SR / rate_hz), short)


def noise_env(dur, rate_hz, decay, vol=0.6, short=False, rate_end=None):
    n = _n(dur)
    if rate_end is None:
        y = noise(dur, rate_hz, short)
    else:  # sweep the clock: render in small blocks
        y = np.empty(n)
        blk = 256
        for i in range(0, n, blk):
            q = i / max(1, n - 1)
            r = rate_hz * (rate_end / rate_hz) ** q
            y[i:i + blk] = _lfsr(min(blk, n - i), max(1.0, SR / r), short)
    env = np.exp(-np.arange(n) / (decay * SR))
    env = np.round(env * 15.0) / 15.0
    return dsp.endfade(y * env * vol, 3.0)


# ------------------------------------------------------------------------------------------------- drums
def kick(vel=1.0):
    n = _n(0.16)
    t = np.arange(n) / SR
    f = 45.0 + 150.0 * np.exp(-t / 0.025)
    ph = np.cumsum(f) / SR % 1.0
    tri = 4.0 * np.abs(ph - 0.5) - 1.0
    tri = np.round((tri + 1.0) * 7.5) / 7.5 - 1.0
    body = tri * np.exp(-t / 0.07)
    click = noise_env(0.012, 22000.0, 0.004, 0.5)
    out = body * 0.95
    out[: click.shape[0]] += click
    return dsp.endfade(out * vel, 4.0)


def snare(vel=1.0):
    nz = noise_env(0.2, 14000.0, 0.06, 0.75)
    tone = pulse_note(55, 0.04, 0.5, 0.35, a=0.001, d=0.02, s=0.0, r=0.01, slide=5, steps=False)
    out = nz.copy()
    out[: tone.shape[0]] += tone
    return out * vel


def hat(vel=1.0, open_=False):
    return noise_env(0.16 if open_ else 0.04, 40000.0, 0.05 if open_ else 0.012, 0.45, short=True) * vel


def crash(vel=1.0):
    return noise_env(1.1, 30000.0, 0.35, 0.5) * vel


def tom(note, vel=1.0):
    return tri_note(note, 0.12, 0.9, slide=7) * np.exp(-np.arange(_n(0.135)) / (0.06 * SR))[: _n(0.135)] * vel
