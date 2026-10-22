"""QA plots and reports: spectrogram, RMS-over-time with bar/hit markers, band balance and event tables."""
from __future__ import annotations

import math

import numpy as np

from .core import SR


def _mpl():
    import matplotlib

    matplotlib.use("Agg")
    matplotlib.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    matplotlib.rcParams["axes.unicode_minus"] = False
    import matplotlib.pyplot as plt

    return plt


def spectrogram(x, path, title="", fmax=20000, grid=None, bars=None, markers=None, figsize=(22, 7)):
    plt = _mpl()
    mono = x.mean(axis=1) if x.ndim == 2 else x
    fig, ax = plt.subplots(figsize=figsize, dpi=90)
    nfft = 2048
    ax.specgram(mono + 1e-9, NFFT=nfft, Fs=SR, noverlap=nfft * 3 // 4, cmap="magma", vmin=-130, vmax=-20, scale="dB")
    ax.set_yscale("symlog", linthresh=200)
    ax.set_ylim(30, fmax)
    ax.set_xlabel("seconds")
    ax.set_ylabel("Hz")
    ax.set_title(title)
    if grid is not None and bars:
        for b in range(1, bars + 2):
            ax.axvline(grid.t(b), color="cyan", lw=0.5, alpha=0.35)
    for t, lab in (markers or []):
        ax.axvline(t, color="lime", lw=0.6, alpha=0.6)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def rms_plot(stems: dict, path, grid=None, bars=None, hits=None, stops=None, win=0.02, figsize=(24, 8)):
    """RMS (dBFS) of each stem over time, with bar lines, hit markers and stop regions."""
    plt = _mpl()
    fig, ax = plt.subplots(figsize=figsize, dpi=90)
    hop = int(win * SR)
    for name, x in stems.items():
        mono = x.mean(axis=1) if x.ndim == 2 else x
        n = mono.shape[0] // hop
        r = np.sqrt((mono[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
        ax.plot(np.arange(n) * win, 20 * np.log10(r), lw=0.8, label=name)
    if grid is not None and bars:
        for b in range(1, bars + 2):
            ax.axvline(grid.t(b), color="gray", lw=0.5, alpha=0.5)
            ax.text(grid.t(b) + 0.03, -5, str(b), fontsize=7, color="gray")
    for t in hits or []:
        ax.axvline(t, color="red", lw=0.7, alpha=0.6, ls="--")
    for a, b in stops or []:
        ax.axvspan(a, b, color="yellow", alpha=0.25)
    ax.set_ylim(-80, 0)
    ax.set_xlabel("seconds")
    ax.set_ylabel("RMS dBFS (20 ms)")
    ax.legend(loc="lower right")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


BANDS = [(20, 60, "sub"), (60, 250, "low"), (250, 500, "lowmid"), (500, 2000, "mid"),
         (2000, 6000, "himid"), (6000, 12000, "high"), (12000, 20000, "air")]


def band_balance(x) -> dict:
    """Average power per band (dB, relative to total) using a Welch PSD."""
    from scipy.signal import welch

    mono = x.mean(axis=1) if x.ndim == 2 else x
    f, p = welch(mono, SR, nperseg=8192)
    total = p[(f >= 20) & (f <= 20000)].sum()
    out = {}
    for lo, hi, name in BANDS:
        m = (f >= lo) & (f < hi)
        out[name] = 10 * math.log10(max(p[m].sum() / total, 1e-12))
    return out


def window_rms_db(x, t0, t1) -> float:
    mono = x.mean(axis=1) if x.ndim == 2 else x
    a, b = int(t0 * SR), int(t1 * SR)
    seg = mono[a:b]
    if seg.size == 0:
        return -200.0
    return 20 * math.log10(math.sqrt(float((seg ** 2).mean()) + 1e-20))


def onset_near(x, t, search=0.03) -> float:
    """Time of the steepest energy rise within ±search s of t (to check hits land on their beats)."""
    mono = np.abs(x.mean(axis=1) if x.ndim == 2 else x)
    hop = int(0.001 * SR)
    a = max(0, int((t - search) * SR))
    b = min(mono.shape[0], int((t + search) * SR))
    seg = mono[a:b]
    n = seg.shape[0] // hop
    if n < 3:
        return t
    env = seg[: n * hop].reshape(n, hop).max(axis=1)
    d = np.diff(env)
    return (a + (int(np.argmax(d)) + 1) * hop) / SR


PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def chroma_top(x, t0, t1, k=4, fmin=90.0, fmax=2200.0):
    """Top-k pitch classes by spectral energy in [t0, t1) (Hann-windowed FFT, harmonics folded by pitch class)."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    seg = mono[int(t0 * SR):int(t1 * SR)]
    if seg.size < 1024:
        return []
    spec = np.abs(np.fft.rfft(seg * np.hanning(seg.size))) ** 2
    f = np.fft.rfftfreq(seg.size, 1.0 / SR)
    m = (f >= fmin) & (f <= fmax)
    midi = 69 + 12 * np.log2(f[m] / 440.0)
    pc = np.mod(np.round(midi), 12).astype(int)
    e = np.bincount(pc, weights=spec[m], minlength=12)
    order = np.argsort(e)[::-1][:k]
    tot = e.sum() + 1e-20
    return [f"{PC_NAMES[i]}({100 * e[i] / tot:.0f}%)" for i in order]


def onset_first(x, t, before=0.008, after=0.04, frac=0.3):
    """Earliest time near t where the 1 ms peak envelope reaches `frac` of the window's maximum rise.
    The look-back is short so a preceding swung 16th or a sidechain recovery isn't mistaken for the hit."""
    mono = np.abs(x.mean(axis=1) if x.ndim == 2 else x)
    hop = int(0.001 * SR)
    a = max(0, int((t - before) * SR))
    b = min(mono.shape[0], int((t + after) * SR))
    seg = mono[a:b]
    n = seg.shape[0] // hop
    if n < 3:
        return t
    env = seg[: n * hop].reshape(n, hop).max(axis=1)
    base = float(np.min(env[: max(1, int(before * 1000) - 2)]))
    peak = float(env.max())
    thr = base + frac * (peak - base)
    idx = int(np.argmax(env >= thr))
    return (a + idx * hop) / SR


def peak_db(x, t0, t1):
    mono = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
    seg = mono[max(0, int(t0 * SR)):int(t1 * SR)]
    return 20 * math.log10(float(seg.max()) + 1e-12) if seg.size else -200.0
