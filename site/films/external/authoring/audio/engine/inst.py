"""Melodic instruments. Each returns a clip (mono or stereo float64) that starts at the note onset and already
includes its release tail, so callers just Bus.add(clip, onset)."""
from __future__ import annotations

import math

import numpy as np
from numba import njit

from .core import SR, mtof
from . import dsp
from . import fx

TWO_PI = 2.0 * math.pi


def _rng(seed):
    return np.random.default_rng(seed)


def _release_env(n, gate_n, release_s, curve=5.0):
    env = np.ones(n)
    if gate_n < n:
        k = np.arange(n - gate_n) / SR
        r = np.exp(-k * curve / max(release_s, 1e-3))
        r *= np.linspace(1.0, 0.0, n - gate_n) ** 0.5
        env[gate_n:] = r
    return env


# -------------------------------------------------------------------------------------- FM electric piano
def ep(note, dur, vel=0.8, release=0.35, seed=0):
    """DX-style tine piano: 1:1 body pair with decaying index + 1:14 'tine' pair for the bell attack."""
    f = mtof(note)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    tau = float(np.clip(1.9 * (261.6 / f) ** 0.6, 0.35, 3.2))
    amp = np.exp(-t / tau) * np.minimum(t / 0.0015, 1.0)
    amp *= _release_env(n, int(dur * SR), release)
    ph = TWO_PI * f * t + _rng(seed).uniform(0, TWO_PI)
    i1 = (0.45 + 1.7 * vel) * np.exp(-t / 0.38) + 0.18
    body = np.sin(ph + i1 * np.sin(ph))
    alias_guard = min(1.0, 520.0 / f)
    i2 = (0.35 + 1.1 * vel) * np.exp(-t / 0.014) * alias_guard
    tine = np.sin(ph + i2 * np.sin(14.0 * ph)) * np.exp(-t / 0.22)
    out = (body + 0.32 * tine) * amp * (0.35 + 0.65 * vel)
    return out


# --------------------------------------------------------------------------------------------- funk bass
def bass(note, dur, vel=0.9, slap=0.0, glide_from=None, glide_t=0.07, release=0.045, seed=0):
    """Saw/square through a resonant LP with a snappy envelope + sine sub; `slap` adds a bright thumb/pop."""
    rng = _rng(seed)
    f0 = mtof(note)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    if glide_from is not None:
        freq = dsp.glide(n, mtof(glide_from), f0, glide_t)
    else:
        freq = np.full(n, f0)
    osc = 0.6 * dsp.saw(freq, phase=rng.uniform()) + 0.35 * dsp.pulse(freq, 0.42, phase=rng.uniform())
    sub = np.sin(TWO_PI * np.cumsum(freq) / SR)
    cut = (170.0 + 520.0 * vel) + (800.0 + 2600.0 * slap + 900.0 * vel) * np.exp(-t / (0.045 + 0.05 * slap))
    y = dsp.svf(osc, cut, 1.15, "lp")
    y = 0.9 * y + 0.45 * sub
    amp = np.minimum(t / 0.002, 1.0) * (0.72 + 0.28 * np.exp(-t / 0.18))
    amp *= _release_env(n, int(dur * SR), release)
    y *= amp
    if slap > 0:
        k = int(0.012 * SR)
        tr = dsp.svf(rng.uniform(-1, 1, k), 2600.0, 1.2, "bpn") * np.exp(-np.arange(k) / (0.0025 * SR))
        pop = np.sin(TWO_PI * 3.0 * f0 * t[:k]) * np.exp(-np.arange(k) / (0.004 * SR))
        y[:k] += slap * (0.35 * tr + 0.25 * pop)
    y = dsp.soft_clip(y * 0.9, 1.7)
    return y * vel


def bass_ghost(note, vel=0.4, seed=0):
    """Dead/muted percussive note ('x' in funk tab)."""
    rng = _rng(seed)
    n = int(0.05 * SR)
    t = dsp.tvec(n)
    f0 = mtof(note)
    body = np.sin(TWO_PI * f0 * t) * np.exp(-t / 0.012)
    nz = dsp.svf(rng.uniform(-1, 1, n), 900.0, 0.9, "lp") * np.exp(-t / 0.008)
    out = 0.7 * body + 0.6 * nz
    out = dsp.endfade(out)
    return out * vel


def sub(note, dur, vel=0.8, release=0.2):
    f = mtof(note)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    env = np.minimum(t / 0.004, 1.0) * _release_env(n, int(dur * SR), release)
    return np.sin(TWO_PI * f * t) * env * vel


# -------------------------------------------------------------------------------------------- synth brass
def brass(notes, dur, vel=0.9, release=0.13, scoop_cents=70.0, bright=1.0, attack=0.011, seed=0):
    """Brass section stab: 3 detuned saw layers (L/C/R) per note, filter 'bwah', pitch scoop, breath."""
    rng = _rng(seed)
    n = int((dur + release) * SR)
    t = dsp.tvec(n)
    scoop = 2.0 ** (-scoop_cents * np.exp(-t / 0.018) / 1200.0)
    cut = (420.0 + (1500.0 + 2600.0 * vel) * bright * (1 - np.exp(-t / max(attack, 0.004))) * (0.55 + 0.45 * np.exp(-t / 0.22)))
    amp = dsp.adsr(dur, a=attack, d=0.22, s=0.72, r=release)[:n]
    if amp.shape[0] < n:
        amp = np.pad(amp, (0, n - amp.shape[0]))
    layers = []
    for det, pan in ((-9.0, -0.45), (0.0, 0.0), (9.0, 0.45)):
        acc = np.zeros(n)
        for note in notes:
            f = mtof(note) * 2.0 ** (det / 1200.0) * scoop
            acc += dsp.saw(f, phase=rng.uniform())
        acc = dsp.svf(acc, cut, 0.85, "lp")
        layers.append((acc, pan))
    out = np.zeros((n, 2))
    for acc, pan in layers:
        gl = math.cos((pan + 1) * math.pi / 4)
        gr = math.sin((pan + 1) * math.pi / 4)
        out[:, 0] += acc * gl
        out[:, 1] += acc * gr
    breath = dsp.svf(rng.uniform(-1, 1, n), 2600.0, 0.9, "bpn") * 0.04 * np.exp(-t / 0.08)
    out += breath[:, None]
    out *= amp[:, None]
    out = dsp.soft_clip(out / max(1.0, math.sqrt(len(notes))) * 0.8, 1.3)
    return out * vel


# ----------------------------------------------------------------------------------------------- strings
def strings(notes, dur, vel=0.6, attack=0.25, release=0.45, cutoff=2600.0, seed=0):
    rng = _rng(seed)
    n = int((dur + release) * SR)
    amp = dsp.adsr(dur, a=attack, d=0.4, s=0.85, r=release)[:n]
    if amp.shape[0] < n:
        amp = np.pad(amp, (0, n - amp.shape[0]))
    out = np.zeros((n, 2))
    dets = (-13.0, -6.0, 0.0, 6.0, 13.0)
    pans = (-0.8, -0.35, 0.0, 0.35, 0.8)
    t = dsp.tvec(n)
    for note in notes:
        f0 = mtof(note)
        for det, pan in zip(dets, pans):
            vib = 2.0 ** (4.0 * np.sin(TWO_PI * (5.1 + rng.uniform(-0.4, 0.4)) * t + rng.uniform(0, 6)) / 1200.0)
            s = dsp.saw(f0 * 2 ** (det / 1200.0) * vib, phase=rng.uniform())
            gl = math.cos((pan + 1) * math.pi / 4)
            gr = math.sin((pan + 1) * math.pi / 4)
            out[:, 0] += s * gl
            out[:, 1] += s * gr
    out = dsp.svf(out, cutoff, 0.7, "lp")
    out = fx.hp(out, 180.0)
    out *= amp[:, None]
    return out * vel / (len(notes) * 2.2)


# ------------------------------------------------------------------------------------- monophonic leads
def _line_curves(events, rel, legato_gap=0.012, glide_t=0.035):
    """Frequency, amplitude-gate and note-onset curves for a monophonic phrase.

    events: list of (start_s, dur_s, note, vel) relative to the phrase start (first start = 0).
    """
    end = max(s + d for s, d, *_ in events) + rel
    n = int(end * SR) + 1
    freq = np.zeros(n)
    gate = np.zeros(n)
    velc = np.zeros(n)
    onsets = []
    prev_f = None
    prev_end = -1.0
    for idx, (s, d, note, v) in enumerate(events):
        i0 = int(s * SR)
        i1 = min(n, int((s + d) * SR))
        nxt = events[idx + 1][0] if idx + 1 < len(events) else None
        f = mtof(note)
        legato = prev_f is not None and s - prev_end < legato_gap
        seg = i1 - i0
        if legato:
            g = dsp.glide(seg, prev_f, f, glide_t)
        else:
            g = np.full(seg, f)
            onsets.append((i0, v))
        freq[i0:i1] = g
        gate[i0:i1] = 1.0
        velc[i0:i1] = v
        # hold pitch through gaps/release
        stop = int(nxt * SR) if nxt is not None else n
        freq[i1:stop] = f
        velc[i1:stop] = v
        prev_f = f
        prev_end = s + d
    first = np.argmax(freq > 0)
    freq[:first] = freq[first]
    return n, freq, gate, velc, onsets


def lead(events, vel_bright=1.0, vib_rate=5.6, vib_cents=16.0, rel=0.07, whistle=0.14, seed=0):
    """Brassy synth lead with portamento on legato notes, delayed vibrato and a soft octave 'whistle' layer."""
    rng = _rng(seed)
    n, freq, gate, velc, onsets = _line_curves(events, rel)
    t = dsp.tvec(n)
    # vibrato that restarts its delay at every onset
    vib_depth = np.zeros(n)
    since = np.full(n, 10.0)
    for i0, _v in onsets:
        since[i0:] = np.minimum(since[i0:], t[i0:] - t[i0])
    # legato notes: also restart depth on each event start
    vib_depth = np.clip((since - 0.16) / 0.22, 0.0, 1.0) * vib_cents
    fmul = 2.0 ** (vib_depth * np.sin(TWO_PI * vib_rate * t) / 1200.0)
    f = freq * fmul
    osc = 0.55 * dsp.saw(f, phase=rng.uniform()) + 0.45 * dsp.pulse(f, 0.32, phase=rng.uniform())
    # per-onset filter accent
    acc = np.zeros(n)
    for i0, v in onsets:
        k = np.arange(n - i0) / SR
        acc[i0:] = np.maximum(acc[i0:], v * np.exp(-k / 0.09))
    cut = (1500.0 + 1300.0 * velc) * vel_bright + 2200.0 * acc
    y = dsp.svf(osc, cut, 0.9, "lp")
    wh = np.sin(TWO_PI * np.cumsum(2.0 * f) / SR) * whistle
    y = y + wh
    # amplitude: smooth gate (attack 6 ms, release rel)
    a = 1.0 - math.exp(-1.0 / (0.006 * SR))
    r = 1.0 - math.exp(-1.0 / (rel / 4 * SR))
    env = _follow(gate, a, r)
    y *= env * (0.55 + 0.45 * velc)
    return dsp.soft_clip(y * 0.8, 1.2)


def trombone(events, wobble_last=True, seed=0):
    """'Sad trombone': saw through a plunger-style wah per note; last note gets growing vibrato and a droop."""
    rng = _rng(seed)
    rel = 0.12
    n, freq, gate, velc, onsets = _line_curves(events, rel, legato_gap=0.0)
    t = dsp.tvec(n)
    f = freq.copy()
    wah = np.zeros(n)
    for idx, (s, d, note, v) in enumerate(events):
        i0 = int(s * SR)
        i1 = min(n, int((s + d + rel) * SR))
        k = (np.arange(i1 - i0) / SR) / max(d, 1e-3)
        # 'wa': opens fast then closes over the note
        wah[i0:i1] = np.maximum(wah[i0:i1], np.clip(np.sin(np.pi * np.clip(k * 1.1, 0, 1)) ** 0.7, 0, 1))
        if wobble_last and idx == len(events) - 1:
            kk = np.arange(i1 - i0) / SR
            depth = np.clip(kk / d, 0, 1) * 45.0
            f[i0:i1] *= 2.0 ** (depth * np.sin(TWO_PI * 6.2 * kk) / 1200.0)
            droop = np.clip((kk - d * 0.7) / (d * 0.5), 0, 1)
            f[i0:i1] *= 2.0 ** (-110.0 * droop ** 2 / 1200.0)
    osc = 0.7 * dsp.saw(f, phase=rng.uniform()) + 0.3 * dsp.pulse(f, 0.45, phase=rng.uniform())
    cut = 380.0 + 1700.0 * wah
    y = dsp.svf(osc, cut, 1.6, "lp")
    a = 1.0 - math.exp(-1.0 / (0.012 * SR))
    r = 1.0 - math.exp(-1.0 / (0.03 * SR))
    env = _follow(gate, a, r)
    return dsp.soft_clip(y * env * 0.9, 1.3)


def _follow(x, a, r):
    return _follow_nb(np.asarray(x, dtype=np.float64), a, r)


@njit(cache=True)
def _follow_nb(x, a, r):
    out = np.empty(x.shape[0])
    y = 0.0
    for i in range(x.shape[0]):
        c = a if x[i] > y else r
        y += c * (x[i] - y)
        out[i] = y
    return out


# --------------------------------------------------------------------------------------- bells / mallets
def glock(note, vel=0.7, dur=1.2, seed=0):
    f = mtof(note)
    n = int(dur * SR)
    t = dsp.tvec(n)
    scale = (880.0 / f) ** 0.3
    out = np.zeros(n)
    for r, a, d in ((1.0, 1.0, 0.9), (2.756, 0.32, 0.32), (5.404, 0.12, 0.13), (8.933, 0.05, 0.06)):
        if f * r < 19000:
            out += a * np.sin(TWO_PI * f * r * t) * np.exp(-t / (d * scale))
    out = dsp.endfade(out * np.minimum(t / 0.0008, 1.0))
    return out * vel


def bell(note, vel=0.7, dur=1.4, ratio=3.5, index=1.6, decay=0.6, seed=0):
    """FM bell: inharmonic sidebands at ratio 3.5, index decays faster than amplitude -> glassy ding."""
    f = mtof(note)
    n = int(dur * SR)
    t = dsp.tvec(n)
    guard = min(1.0, 1400.0 / f)
    idx = index * guard * np.exp(-t / (decay * 0.35))
    out = np.sin(TWO_PI * f * t + idx * np.sin(TWO_PI * f * ratio * t))
    out += 0.25 * np.sin(TWO_PI * f * 2.0 * t) * np.exp(-t / (decay * 0.4))
    out = dsp.endfade(out * np.exp(-t / decay) * np.minimum(t / 0.001, 1.0))
    return out * vel


def marimba(note, vel=0.8, dur=0.5):
    f = mtof(note)
    n = int(dur * SR)
    t = dsp.tvec(n)
    out = np.sin(TWO_PI * f * t) * np.exp(-t / 0.18) + 0.35 * np.sin(TWO_PI * f * 4.0 * t) * np.exp(-t / 0.03)
    out += 0.12 * np.sin(TWO_PI * f * 9.9 * t) * np.exp(-t / 0.01)
    out = dsp.endfade(out * np.minimum(t / 0.0007, 1.0))
    return out * vel


# ----------------------------------------------------------------------------------------- guitar chops
def guitar_chop(notes, dur=0.08, vel=0.7, wah=0.5, strum_ms=4.0, seed=0):
    """Muted funk 'chk' chord: Karplus-Strong strings with quick mute and a fixed wah colour."""
    rng = _rng(seed)
    total = dur + 0.06
    n = int(total * SR)
    out = np.zeros(n)
    for k, note in enumerate(notes):
        off = int(k * strum_ms / 1000.0 * SR)
        s = dsp.karplus(mtof(note), total, rng, fb=0.993, damp=0.55, bright=0.75)
        out[off:] += s[: n - off]
    t = dsp.tvec(n)
    mute = np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.012))
    out *= mute
    out = dsp.svf(out, 700.0 + 1700.0 * wah, 2.2, "bpn") * 0.8 + out * 0.35
    out = dsp.endfade(out)
    return out * vel / max(1.0, len(notes) ** 0.5)


def pluck(note, vel=0.7, dur=0.6, bright=0.6, seed=0):
    rng = _rng(seed)
    s = dsp.karplus(mtof(note), dur, rng, fb=0.996, damp=0.5, bright=bright)
    s = dsp.endfade(s)
    return s * vel
