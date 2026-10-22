"""Effects and mastering: pedalboard wrappers, reverb/delay sends, sidechain ducking, loudness and true peak."""
from __future__ import annotations

import math

import numpy as np
import pedalboard as pb
from numba import njit
from scipy.signal import resample_poly

from .core import SR, db
from . import dsp


def run(x: np.ndarray, *plugins, tail_s: float = 0.0) -> np.ndarray:
    """Process mono/stereo float64 audio through pedalboard plugins; returns same layout (optionally longer)."""
    mono = x.ndim == 1
    data = x[:, None] if mono else x
    if tail_s > 0:
        data = np.concatenate([data, np.zeros((int(tail_s * SR), data.shape[1]))], axis=0)
    board = pb.Pedalboard(list(plugins))
    out = board(np.ascontiguousarray(data.T.astype(np.float32)), SR, reset=True).T.astype(np.float64)
    return out[:, 0] if mono else out


# ------------------------------------------------------------------------------------------- tone shaping
def hp(x, hz, order=1):
    for _ in range(order):
        x = run(x, pb.HighpassFilter(cutoff_frequency_hz=hz))
    return x


def lp(x, hz, order=1):
    for _ in range(order):
        x = run(x, pb.LowpassFilter(cutoff_frequency_hz=hz))
    return x


def eq(x, bands):
    """bands: list of ('peak'|'low'|'high', hz, gain_db, q)."""
    plugs = []
    for kind, hz, g, q in bands:
        if kind == "peak":
            plugs.append(pb.PeakFilter(cutoff_frequency_hz=hz, gain_db=g, q=q))
        elif kind == "low":
            plugs.append(pb.LowShelfFilter(cutoff_frequency_hz=hz, gain_db=g, q=q))
        elif kind == "high":
            plugs.append(pb.HighShelfFilter(cutoff_frequency_hz=hz, gain_db=g, q=q))
    return run(x, *plugs)


def comp(x, threshold_db=-18.0, ratio=3.0, attack_ms=5.0, release_ms=120.0, makeup_db=0.0):
    y = run(x, pb.Compressor(threshold_db=threshold_db, ratio=ratio, attack_ms=attack_ms, release_ms=release_ms))
    return y * db(makeup_db)


def reverb(x, size=0.5, damping=0.5, width=0.9, wet_only=True, predelay_ms=0.0, hp_hz=200.0, lp_hz=9000.0):
    """Wet reverb return (100% wet), filtered so tails never muddy the lows or fizz the top."""
    src = x if x.ndim == 2 else np.stack([x, x], axis=1)
    if predelay_ms > 0:
        pad = int(predelay_ms / 1000.0 * SR)
        src = np.concatenate([np.zeros((pad, 2)), src[:-pad]], axis=0) if pad < src.shape[0] else np.zeros_like(src)
    wet = run(src, pb.Reverb(room_size=size, damping=damping, wet_level=1.0, dry_level=0.0, width=width))
    wet = hp(wet, hp_hz)
    wet = lp(wet, lp_hz)
    return wet


def delay(x, time_s, feedback=0.3, mix_lp=5000.0, hp_hz=300.0, pingpong=True):
    """Wet-only tempo delay with darkening repeats (manual implementation so ping-pong is possible)."""
    src = x if x.ndim == 2 else np.stack([x, x], axis=1)
    n = src.shape[0]
    d = int(round(time_s * SR))
    out = np.zeros_like(src)
    tap = src.mean(axis=1)
    g = 1.0
    side = 0
    cur = tap.copy()
    for k in range(1, 9):
        g *= feedback if k > 1 else 1.0
        if g < 0.02 or k * d >= n:
            break
        cur = dsp.onepole_lp(cur, mix_lp)
        shifted = np.zeros(n)
        shifted[k * d:] = cur[: n - k * d]
        if pingpong:
            out[:, side] += shifted * g
            side = 1 - side
        else:
            out[:, 0] += shifted * g
            out[:, 1] += shifted * g
    return hp(out, hp_hz)


def chorus(x, rate=0.8, depth=0.25, mix=0.4, centre_ms=7.0):
    return run(x if x.ndim == 2 else np.stack([x, x], axis=1),
               pb.Chorus(rate_hz=rate, depth=depth, centre_delay_ms=centre_ms, feedback=0.0, mix=mix))


def widen(x, amount=1.2):
    """Mid/side width. amount 1 = unchanged."""
    if x.ndim == 1:
        return x
    m = (x[:, 0] + x[:, 1]) * 0.5
    s = (x[:, 0] - x[:, 1]) * 0.5 * amount
    return np.stack([m + s, m - s], axis=1)


def mono_below(x, hz=150.0):
    """Collapse lows to mono for mono-compatible bass."""
    if x.ndim == 1:
        return x
    low = lp(x, hz, order=2)
    high = x - low
    lm = low.mean(axis=1, keepdims=True)
    return high + np.repeat(lm, 2, axis=1)


def autopan(x, rate=4.0, depth=0.3, phase=0.0):
    n = x.shape[0]
    t = np.arange(n) / SR
    p = depth * np.sin(2 * math.pi * rate * t + phase)
    mono = x if x.ndim == 1 else x.mean(axis=1)
    gl = np.cos((p + 1) * math.pi / 4) * math.sqrt(2)
    gr = np.sin((p + 1) * math.pi / 4) * math.sqrt(2)
    return np.stack([mono * gl, mono * gr], axis=1) * (1 / math.sqrt(2))


# ------------------------------------------------------------------------------------------------ ducking
def gain_curve(n: int, regions, attack=0.03, release=0.2) -> np.ndarray:
    """Linear gain curve from regions [(start_s, end_s, depth_db), ...]: fast ramp into each duck, slow recovery."""
    target_db = np.zeros(n)
    for s, e, d in regions:
        i0 = max(0, int((s - attack) * SR))
        i1 = min(n, int(e * SR))
        if i1 > i0:
            target_db[i0:i1] = np.minimum(target_db[i0:i1], -abs(d))
    a = 1.0 - math.exp(-1.0 / (attack * SR))
    r = 1.0 - math.exp(-1.0 / (release * SR))
    return 10.0 ** (_smooth_db(target_db, a, r) / 20.0)


@njit(cache=True)
def _smooth_db(target, a, r):
    out = np.empty(target.shape[0])
    y = 0.0
    for i in range(target.shape[0]):
        t = target[i]
        c = a if t < y else r
        y += c * (t - y)
        out[i] = y
    return out


def sidechain(n: int, times_s, depth_db=4.0, hold=0.03, release=0.18) -> np.ndarray:
    """Pump curve: instant dip at each trigger time, exponential recovery."""
    g_db = np.zeros(n)
    rel_n = int(release * 5 * SR)
    curve = None
    for t in times_s:
        i0 = int(t * SR)
        if i0 >= n:
            continue
        if curve is None:
            k = np.arange(rel_n) / SR
            hold_n = int(hold * SR)
            curve = -depth_db * np.where(k < hold, 1.0, np.exp(-(k - hold) / release))
            curve[: max(1, int(0.002 * SR))] *= np.linspace(0, 1, max(1, int(0.002 * SR)))
        m = min(rel_n, n - i0)
        g_db[i0:i0 + m] = np.minimum(g_db[i0:i0 + m], curve[:m])
    return 10.0 ** (g_db / 20.0)


# ---------------------------------------------------------------------------------------------- mastering
def lufs(x: np.ndarray) -> float:
    import pyloudnorm as pyln

    meter = pyln.Meter(SR)
    return float(meter.integrated_loudness(x if x.ndim == 2 else np.stack([x, x], 1)))


def true_peak_db(x: np.ndarray) -> float:
    up = resample_poly(x, 4, 1, axis=0)
    return 20.0 * math.log10(max(float(np.max(np.abs(up))), 1e-12))


def master(x: np.ndarray, target_lufs=-14.0, ceiling_dbtp=-1.0, glue=True) -> tuple[np.ndarray, dict]:
    """Glue compression + iterative gain/limiter so the result hits target LUFS with true peak under the ceiling."""
    y = dsp.dc_block(x)
    if glue:
        y = comp(y, threshold_db=-16.0, ratio=1.8, attack_ms=20.0, release_ms=180.0)
    info = {}
    gain = target_lufs - lufs(y)
    lim_thr = ceiling_dbtp - 0.6
    out = y
    for it in range(8):
        z = y * db(gain)
        z = run(z, pb.Limiter(threshold_db=lim_thr, release_ms=80.0))
        # Safety: hard ceiling slightly below threshold for inter-sample overs
        tp = true_peak_db(z)
        if tp > ceiling_dbtp:
            z *= db(ceiling_dbtp - tp - 0.05)
        L = lufs(z)
        out = z
        info = {"lufs": L, "true_peak_dbtp": true_peak_db(z), "gain_db": gain, "iter": it}
        if abs(L - target_lufs) <= 0.15:
            break
        gain += target_lufs - L
    return out, info
