"""Instruments added for films B and C (kept separate from inst.py so film A's sounds can never drift)."""
from __future__ import annotations

import math

import numpy as np

from .core import SR, mtof
from . import dsp
from . import fx
from .inst import _release_env

TWO_PI = 2.0 * math.pi


def _rng(seed):
    return np.random.default_rng(seed)


def _pad_to(env, n):
    env = env[:n]
    return np.pad(env, (0, n - env.shape[0])) if env.shape[0] < n else env


def kalimba(note, vel=0.8, dur=0.9, seed=0):
    """Thumb-piano tine: warm fundamental, quick inharmonic 'clink' partials and a tiny pluck click."""
    rng = _rng(seed)
    f = mtof(note)
    n = int(dur * SR)
    t = dsp.tvec(n)
    out = np.sin(TWO_PI * f * t) * np.exp(-t / 0.55)
    out += 0.12 * np.sin(TWO_PI * 2.0 * f * t) * np.exp(-t / 0.25)
    if f * 5.4 < 18000:
        out += 0.22 * np.sin(TWO_PI * 5.4 * f * t) * np.exp(-t / 0.05)
    if f * 9.1 < 18000:
        out += 0.08 * np.sin(TWO_PI * 9.1 * f * t) * np.exp(-t / 0.018)
    k = int(0.003 * SR)
    out[:k] += dsp.svf(rng.uniform(-1, 1, k), 3200.0, 1.0, "bpn") * np.linspace(0.5, 0, k)
    out = dsp.endfade(out * np.minimum(t / 0.0008, 1.0))
    return out * vel


def house_stab(notes, dur=0.2, vel=0.85, bright=1.0, release=0.09, seed=0):
    """Plucky deep-house chord: detuned saws + thin pulse through a resonant LP with a fast 'quack' envelope."""
    rng = _rng(seed)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    cut = 520.0 + (2300.0 + 2600.0 * vel) * bright * np.exp(-t / 0.055)
    amp = np.minimum(t / 0.002, 1.0) * (0.3 + 0.7 * np.exp(-t / 0.15)) * _release_env(n, int(dur * SR), release)
    out = np.zeros((n, 2))
    for det, pan in ((-7.0, -0.35), (7.0, 0.35)):
        acc = np.zeros(n)
        for note in notes:
            f = np.full(n, mtof(note) * 2.0 ** (det / 1200.0))
            acc += dsp.saw(f, phase=rng.uniform()) + 0.4 * dsp.pulse(f, 0.3, phase=rng.uniform())
        acc = dsp.svf(acc, cut, 1.5, "lp")
        out[:, 0] += acc * math.cos((pan + 1) * math.pi / 4)
        out[:, 1] += acc * math.sin((pan + 1) * math.pi / 4)
    out *= amp[:, None]
    return dsp.soft_clip(out / max(1.0, len(notes) ** 0.7) * 0.7, 1.2) * vel


def rubber_bass(note, dur, vel=0.9, bloop=5.0, glide_from=None, glide_t=0.06, release=0.05, seed=0):
    """Rubbery house bass: pulse/saw with a short downward 'bloop' pitch drop into the note and a resonant LP."""
    rng = _rng(seed)
    f0 = mtof(note)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    base = dsp.glide(n, mtof(glide_from), f0, glide_t) if glide_from is not None else np.full(n, f0)
    freq = base * 2.0 ** (bloop * np.exp(-t / 0.022) / 12.0)
    osc = 0.6 * dsp.pulse(freq, 0.5, phase=rng.uniform()) + 0.45 * dsp.saw(freq, phase=rng.uniform())
    cut = 230.0 + 300.0 * vel + 1700.0 * vel * np.exp(-t / 0.07)
    y = dsp.svf(osc, cut, 2.0, "lp")
    y = 0.85 * y + 0.5 * np.sin(TWO_PI * np.cumsum(freq) / SR)
    amp = np.minimum(t / 0.003, 1.0) * (0.78 + 0.22 * np.exp(-t / 0.12)) * _release_env(n, int(dur * SR), release)
    return dsp.soft_clip(y * amp * 0.9, 1.6) * vel


def soft_pad(notes, dur, vel=0.4, attack=0.6, release=1.0, cutoff=2200.0, seed=0):
    """Airy pad: detuned triangles + a faint octave sine, slow attack, gentle LP; stereo by detune pans."""
    rng = _rng(seed)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    amp = _pad_to(dsp.adsr(dur, a=attack, d=0.5, s=0.9, r=release), n)
    out = np.zeros((n, 2))
    for note in notes:
        f0 = mtof(note)
        for det, pan in ((-9.0, -0.7), (0.0, 0.0), (9.0, 0.7)):
            vib = 2.0 ** (5.0 * np.sin(TWO_PI * rng.uniform(0.25, 0.45) * t + rng.uniform(0, 6)) / 1200.0)
            s = dsp.triangle(f0 * 2.0 ** (det / 1200.0) * vib, phase=rng.uniform())
            s = s + 0.18 * np.sin(TWO_PI * 2.0 * f0 * t + rng.uniform(0, 6))
            out[:, 0] += s * math.cos((pan + 1) * math.pi / 4)
            out[:, 1] += s * math.sin((pan + 1) * math.pi / 4)
    out = dsp.svf(out, cutoff, 0.6, "lp")
    out *= amp[:, None]
    return out * vel / (len(notes) * 2.0)


def supersaw(notes, dur, vel=0.7, bend_from=0.0, bend_time=0.12, attack=0.008, release=0.25, cutoff=6500.0,
             voices=7, detune=18.0, swell=0.0, seed=0):
    """Future-bass chord: 7 detuned saws per note across the stereo field, optional pitch bend into the chord
    (bend_from semitones -> 0 over ~bend_time) and optional volume swell (seconds)."""
    rng = _rng(seed)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    bend = 2.0 ** (bend_from * np.exp(-t / max(bend_time / 3.0, 1e-3)) / 12.0) if bend_from else np.ones(n)
    amp = _pad_to(dsp.adsr(dur, a=max(attack, swell), d=0.3, s=0.85, r=release), n)
    out = np.zeros((n, 2))
    offs = np.linspace(-1.0, 1.0, voices)
    for note in notes:
        f0 = mtof(note)
        for o in offs:
            s = dsp.saw(f0 * 2.0 ** (o * detune / 1200.0) * bend, phase=rng.uniform())
            pan = o * 0.85
            out[:, 0] += s * math.cos((pan + 1) * math.pi / 4)
            out[:, 1] += s * math.sin((pan + 1) * math.pi / 4)
    cut = cutoff * (0.75 + 0.25 * np.exp(-t / 0.2))
    out = dsp.svf(out, cut, 0.7, "lp")
    out = fx.hp(out, 140.0)
    out *= amp[:, None]
    return out * vel / (len(notes) * voices * 0.32)


def sub808(note, dur, vel=0.9, glide_from=None, glide_t=0.08, release=0.12, drive=1.5):
    """Round 808-style sub: sine with a small pitch drop at the onset, gentle saturation."""
    f0 = mtof(note)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    base = dsp.glide(n, mtof(glide_from), f0, glide_t) if glide_from is not None else np.full(n, f0)
    f = base * 2.0 ** (3.0 * np.exp(-t / 0.03) / 12.0)
    y = np.sin(TWO_PI * np.cumsum(f) / SR)
    env = np.minimum(t / 0.003, 1.0) * (0.85 + 0.15 * np.exp(-t / 0.2)) * _release_env(n, int(dur * SR), release)
    return dsp.soft_clip(y * env, drive) * vel


def musicbox(note, vel=0.6, dur=1.3, seed=0):
    """Music-box comb tine: bright fundamental, octave and a faint metallic partial, short soft decay."""
    rng = _rng(seed)
    f = mtof(note)
    n = int(dur * SR)
    t = dsp.tvec(n)
    d = 0.5 * (1046.0 / f) ** 0.25
    out = np.sin(TWO_PI * f * t + rng.uniform(0, TWO_PI)) * np.exp(-t / d)
    out += 0.3 * np.sin(TWO_PI * 2.0 * f * t) * np.exp(-t / (d * 0.5))
    if f * 4.2 < 18000:
        out += 0.07 * np.sin(TWO_PI * 4.2 * f * t) * np.exp(-t / 0.03)
    out = dsp.endfade(out * np.minimum(t / 0.0006, 1.0))
    return out * vel


def saw_pluck(note, dur=0.25, vel=0.8, bright=1.0, seed=0):
    """Glossy synth pluck: two detuned saws through a fast-closing LP."""
    rng = _rng(seed)
    f = mtof(note)
    n = int((dur + 0.15) * SR)
    t = dsp.tvec(n)
    s = dsp.saw(np.full(n, f * 2 ** (-5 / 1200)), phase=rng.uniform()) + dsp.saw(np.full(n, f * 2 ** (5 / 1200)), phase=rng.uniform())
    cut = 700.0 + 5200.0 * bright * vel * np.exp(-t / 0.07)
    y = dsp.svf(s, cut, 1.1, "lp") * np.exp(-t / 0.18) * np.minimum(t / 0.002, 1.0)
    return dsp.endfade(y * 0.6) * vel
