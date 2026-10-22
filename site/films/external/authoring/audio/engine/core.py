"""Timing grid, stereo buses, gain/pan helpers and WAV I/O shared by every film's build script."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

SR = 48000


def db(x_db: float) -> float:
    """Decibels -> linear amplitude."""
    return 10.0 ** (x_db / 20.0)


def to_db(x: float) -> float:
    return 20.0 * math.log10(max(x, 1e-12))


def mtof(note: float) -> float:
    """MIDI note number -> frequency in Hz (A4 = 69 = 440 Hz)."""
    return 440.0 * 2.0 ** ((note - 69.0) / 12.0)


_NOTE_INDEX = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def nn(name: str) -> int:
    """Note name like 'A1', 'F#2', 'Bb3' -> MIDI number (C4 = 60)."""
    letter = name[0].upper()
    rest = name[1:]
    acc = 0
    while rest and rest[0] in "#b":
        acc += 1 if rest[0] == "#" else -1
        rest = rest[1:]
    octave = int(rest)
    return 12 * (octave + 1) + _NOTE_INDEX[letter] + acc


class Grid:
    """Musical time grid. Positions are [bar, beat], both 1-indexed; beat may be fractional.

    Swing applies only to odd 16th steps inside step_t(), never to beats or 8ths, so cue hits stay exact.
    """

    def __init__(self, bpm: float, beats_per_bar: int = 4, offset: float = 0.0, swing: float = 0.5):
        self.bpm = bpm
        self.bpb = beats_per_bar
        self.offset = offset
        self.swing = swing

    @property
    def beat(self) -> float:
        return 60.0 / self.bpm

    @property
    def bar(self) -> float:
        return self.beat * self.bpb

    def t(self, bar: float, beat: float = 1.0) -> float:
        return self.offset + ((bar - 1) * self.bpb + (beat - 1)) * self.beat

    def pos(self, p) -> float:
        return self.t(p[0], p[1] if len(p) > 1 else 1.0)

    def step_t(self, bar: int, step: float, swing: float | None = None) -> float:
        """Start time of 16th step (0..15, fractional allowed) in a bar, with 16th swing on odd steps."""
        sw = self.swing if swing is None else swing
        eighth = self.beat / 2.0
        whole = int(math.floor(step))
        frac = step - whole
        base = self.t(bar) + (whole // 2) * eighth
        if whole % 2 == 1:
            base += sw * eighth
        if frac:
            base += frac * eighth / 2.0
        return base

    def steps(self, n_steps: float) -> float:
        """Duration of n 16th steps in seconds."""
        return n_steps * self.beat / 4.0

    @staticmethod
    def from_cues(cues: dict, swing: float = 0.5) -> "Grid":
        return Grid(cues["bpm"], cues.get("beatsPerBar", 4), 0.0, swing)


def load_cues(path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def pan_gains(pan: float) -> tuple[float, float]:
    """Constant-power pan law; pan in [-1, 1]."""
    p = (min(max(pan, -1.0), 1.0) + 1.0) * math.pi / 4.0
    return math.cos(p), math.sin(p)


def to_stereo(sig: np.ndarray, pan: float = 0.0) -> np.ndarray:
    if sig.ndim == 2:
        if pan == 0.0:
            return sig
        gl, gr = pan_gains(pan)
        out = sig.copy()
        out[:, 0] *= gl * math.sqrt(2.0)
        out[:, 1] *= gr * math.sqrt(2.0)
        return out
    gl, gr = pan_gains(pan)
    return np.stack([sig * gl, sig * gr], axis=1)


def fade(sig: np.ndarray, fade_in: float = 0.002, fade_out: float = 0.005) -> np.ndarray:
    """Short raised-cosine fades to kill clicks at note boundaries."""
    out = sig.copy()
    n = out.shape[0]
    fi = min(int(fade_in * SR), n // 2)
    fo = min(int(fade_out * SR), n // 2)
    if fi > 0:
        w = 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, fi))
        out[:fi] = (out[:fi].T * w).T
    if fo > 0:
        w = 0.5 + 0.5 * np.cos(np.linspace(0, math.pi, fo))
        out[n - fo:] = (out[n - fo:].T * w).T
    return out


class Bus:
    """A stereo mix buffer of fixed length. add() places a mono/stereo clip at a time in seconds."""

    def __init__(self, seconds: float, name: str = ""):
        self.n = int(round(seconds * SR))
        self.x = np.zeros((self.n, 2), dtype=np.float64)
        self.name = name

    def add(self, sig: np.ndarray, start_s: float, gain_db: float = 0.0, pan: float = 0.0):
        if sig is None or sig.shape[0] == 0:
            return
        st = to_stereo(sig, pan) * db(gain_db)
        i0 = int(round(start_s * SR))
        if i0 >= self.n:
            return
        j0 = 0
        if i0 < 0:
            j0 = -i0
            i0 = 0
        m = min(st.shape[0] - j0, self.n - i0)
        if m <= 0:
            return
        self.x[i0:i0 + m] += st[j0:j0 + m]

    def mix(self, other: "Bus", gain_db: float = 0.0):
        self.x += other.x * db(gain_db)

    def peak(self) -> float:
        return float(np.max(np.abs(self.x))) if self.n else 0.0


def write_wav(path, x: np.ndarray, bit_depth: int = 24):
    """Write float stereo (n, 2) to WAV via pedalboard's AudioFile (supports 24-bit PCM)."""
    from pedalboard.io import AudioFile

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.ascontiguousarray(np.clip(x, -1.0, 1.0).T.astype(np.float32))
    with AudioFile(str(path), "w", samplerate=SR, num_channels=data.shape[0], bit_depth=bit_depth) as f:
        f.write(data)


def read_wav(path) -> np.ndarray:
    from pedalboard.io import AudioFile

    with AudioFile(str(path)) as f:
        data = f.read(f.frames)
    return data.T.astype(np.float64)
