"""Animalese — a language-neutral, cute pseudo-language for Piik characters (one voice track, any subtitles).

Stable API (other films import this; keep signatures compatible):

    speak(length, who="tuan", mood="neutral", seed=0, sr=48000, *, max_dur=None,
          question=None, exclaim=None, hesitate=None) -> np.ndarray (n, 2) float64
        length  float = seconds of speech | int = number of syllables | str = a subtitle line (only its LENGTH and
                punctuation are used: ?/？ rising end, !/！ exclamation peak, …/... hesitation; never its words)
        who     profile name (tuan yuan dian cong piik monster, or anything registered) or a profile dict
        mood    neutral calm cocky cheerful excited bored thinking sheepish whiny question exclaim hesitant laugh
        seed    int; same inputs -> bit-identical output. Use line_seed(film, index).
        returns stereo, peak 0.8, starts at the first syllable (no leading silence), never longer than max_dur.

    speak_line(line, beat_s, film, index, sr=48000) -> np.ndarray (n, 2)
        cue-sheet helper: line = {"who","mood","beats","zh"/"en"}; fills ~85% of the beat budget, reads punctuation
        from zh/en, seed = line_seed(film, index).

    voice_profile(name, base_hz, brightness=1.0, formant=1.0, **traits) -> dict
        register/replace a character. traits: breath, smooth, bubbly, wobble, growl, electronic, rate, range_st,
        pan, vowels.

    line_seed(film, index) -> int      layout(text) -> [(pos, 'comma'|'hesitate')]      PROFILES      MOODS

Design: syllables come from duration x mood rate (~11-14 syll/s), never from text. Each syllable is a consonant tick
+ a 40-80 ms formant blip on a glottal-ish source; syllables group into 1-4 syllable 'words' with micro-pauses so
the rhythm feels like speech, while pitch follows a per-mood sentence contour.
"""
from __future__ import annotations

import math
import zlib

import numpy as np

from . import dsp

TWO_PI = 2.0 * math.pi

_VOW = {
    "a": (850, 1220, 2810, 3800), "e": (520, 1850, 2650, 3700), "i": (300, 2300, 3050, 3900),
    "o": (560, 900, 2600, 3600), "u": (340, 760, 2450, 3500), "y": (300, 1900, 2350, 3600),
}
_BW = (90.0, 120.0, 170.0, 240.0)
_FG = (1.0, 0.55, 0.24, 0.09)
_DIPH = ["ai", "ao", "ei", "ou", "ia", "ua"]
_CONS = ["", "b", "p", "d", "t", "k", "g", "m", "n", "l", "h", "s"]

PROFILES: dict = {}


def voice_profile(name, base_hz, brightness=1.0, formant=1.0, *, breath=0.05, smooth=0.0, bubbly=0.0, wobble=0.0,
                  growl=0.0, electronic=0.0, rate=1.0, range_st=1.0, pan=0.0, vowels="aeiou"):
    """Register (or replace) a character voice and return it.

    base_hz pitch centre; brightness source tilt (0.6 dark .. 1.3 bright); formant vowel-formant scale (1.0 adult,
    1.2-1.35 small/cute, 0.8 big); smooth 0..1 legato & soft consonants; bubbly 0..1 bouncy pitch & poppy attacks;
    wobble 0..1 goofy vibrato; growl 0..1 rough subharmonic (monsters); electronic 0..1 square/bit-crushed (robots,
    the TV mascot); rate syllable-rate multiplier; range_st contour width multiplier; pan -1..1; vowels preferred.
    """
    p = dict(name=name, base_hz=float(base_hz), brightness=float(brightness), formant=float(formant),
             breath=float(breath), smooth=float(smooth), bubbly=float(bubbly), wobble=float(wobble),
             growl=float(growl), electronic=float(electronic), rate=float(rate), range_st=float(range_st),
             pan=float(pan), vowels=str(vowels))
    PROFILES[name] = p
    return p


voice_profile("tuan", 232.0, 1.0, 1.12, breath=0.05, pan=-0.08, vowels="aaeiou")
voice_profile("yuan", 300.0, 0.85, 1.2, breath=0.14, smooth=0.85, rate=0.94, range_st=0.85, pan=0.12, vowels="aeioa")
voice_profile("dian", 385.0, 1.12, 1.3, breath=0.06, bubbly=1.0, rate=1.08, range_st=1.25, pan=-0.22, vowels="aiiea")
voice_profile("cong", 148.0, 0.95, 1.0, breath=0.05, wobble=1.0, rate=0.92, range_st=1.1, pan=0.22, vowels="oouaa")
voice_profile("piik", 470.0, 1.15, 1.35, breath=0.0, electronic=1.0, bubbly=0.5, rate=1.1, range_st=1.2, vowels="iiea")
voice_profile("monster", 92.0, 0.8, 0.82, breath=0.08, growl=1.0, rate=0.85, range_st=0.9, vowels="oouua")

# rate syll/s, pitch st offset, range (contour scale), decl st over the line, energy, legato, shape
MOODS = {
    "neutral": dict(rate=12.5, pitch=0.0, range=1.0, decl=-2.0, energy=1.0, legato=False, shape="statement"),
    "calm": dict(rate=11.5, pitch=-0.5, range=0.8, decl=-2.0, energy=0.9, legato=True, shape="statement"),
    "cocky": dict(rate=13.5, pitch=1.5, range=1.4, decl=0.5, energy=1.0, legato=False, shape="bounce"),
    "cheerful": dict(rate=13.5, pitch=2.0, range=1.3, decl=0.0, energy=1.0, legato=False, shape="bounce"),
    "excited": dict(rate=14.0, pitch=3.0, range=1.5, decl=0.0, energy=1.05, legato=False, shape="exclaim"),
    "bored": dict(rate=9.5, pitch=-3.0, range=0.5, decl=-3.0, energy=0.8, legato=True, shape="bored"),
    "thinking": dict(rate=10.5, pitch=-1.0, range=0.6, decl=-3.0, energy=0.8, legato=True, shape="statement"),
    "sheepish": dict(rate=10.5, pitch=-0.5, range=0.6, decl=-2.5, energy=0.75, legato=True, shape="hesitant"),
    "whiny": dict(rate=11.0, pitch=3.0, range=1.1, decl=0.0, energy=0.95, legato=True, shape="whiny"),
    "question": dict(rate=12.5, pitch=0.5, range=1.0, decl=-1.0, energy=1.0, legato=False, shape="question"),
    "exclaim": dict(rate=13.5, pitch=2.0, range=1.4, decl=0.0, energy=1.05, legato=False, shape="exclaim"),
    "hesitant": dict(rate=11.0, pitch=-0.5, range=0.8, decl=-2.0, energy=0.85, legato=True, shape="hesitant"),
    "laugh": dict(rate=8.5, pitch=2.0, range=1.0, decl=-4.0, energy=1.0, legato=False, shape="laugh"),
}


def line_seed(film, index) -> int:
    """Stable seed from a film id and line index (no Python hash randomisation)."""
    return zlib.crc32(f"{film}:{index}".encode("utf-8")) & 0x7FFFFFFF


def _flags(text):
    t = text.strip()
    q = t.endswith(("?", "？")) or "?" in t[-3:] or "？" in t[-3:]
    e = ("!" in t) or ("！" in t)
    h = ("…" in t) or ("..." in t)
    return q, e, h


_COMMAS = "，,、；;：:"
_PUNCT = "…。，,.!！?？、；;：:\"'“”‘’()（）-—"


def layout(text):
    """Relative positions (0..1 of the visible text) of phrase breaks: [(pos, 'comma'|'hesitate'), ...]."""
    vis = [ch for ch in text if not ch.isspace() and ch not in _PUNCT]
    total = max(1, len(vis))
    seen = 0
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "…" or text.startswith("...", i):
            j = i
            while j < len(text) and (text[j] == "…" or text[j] == "."):
                j += 1
            out.append((seen / total, "hesitate"))
            i = j
            continue
        if ch in _COMMAS and 0 < seen < total:
            out.append((seen / total, "comma"))
        elif not ch.isspace() and ch not in _PUNCT:
            seen += 1
        i += 1
    return out


# ----------------------------------------------------------------------------------------------- planning
def _hesitation(syl, t, period, rng, count):
    """'uh… uh…' — slower, falling, a little breathy blips. Returns the time after them."""
    for k in range(count):
        d = period * float(rng.uniform(1.6, 2.1))
        syl.append(dict(t=t, d=d, st=-1.0 - 1.6 * k, vowel=str(rng.choice(["a", "e", "u"])), cons="",
                        amp=0.7 - 0.08 * k, breathy=0.25, hes=True))
        t += d + period * float(rng.uniform(0.9, 1.4))
    return t


def _plan(n_target, dur_target, mood, prof, flags, rng, breaks=()):
    """Syllable plan: list of dict(t, d, st, vowel, cons, amp, breathy). Times relative to the first onset."""
    md = MOODS.get(mood, MOODS["neutral"])
    question, exclaim, hesitate = flags
    shape = md["shape"]
    rate = md["rate"] * prof["rate"] * float(rng.uniform(0.97, 1.03))
    period = 1.0 / rate
    rng_st = md["range"] * prof["range_st"]
    syl = []
    t = 0.0
    breaks = sorted(breaks)
    lead = [b for b in breaks if b[1] == "hesitate" and b[0] < 0.15]
    mid = [b for b in breaks if not (b[1] == "hesitate" and b[0] < 0.15)]
    if shape == "hesitant" or lead or (hesitate and not mid):
        t = _hesitation(syl, t, period, rng, int(rng.integers(2, 4)))
    span = dur_target if dur_target else (n_target or 8) * period
    pending = [(t + p * max(span - t, 0.0), kind) for p, kind in mid]
    if shape == "laugh":
        n = n_target if n_target else max(3, int(round((dur_target or 0.8) * rate)))
        for k in range(n):
            d = period * 0.62
            syl.append(dict(t=t, d=d, st=3.0 - 1.1 * k + float(rng.uniform(-0.4, 0.4)), vowel="a", cons="h",
                            amp=1.0 - 0.07 * k, breathy=0.45, hes=False))
            t += period * float(rng.uniform(0.95, 1.05))
        return syl, md
    # words of 1-4 syllables, micro-pauses between them
    count = 0
    limit_n = n_target
    limit_t = dur_target
    while True:
        while pending and t >= pending[0][0] - period * 0.5:
            _, kind = pending.pop(0)
            if kind == "hesitate":
                t += period * 0.8
                t = _hesitation(syl, t, period, rng, int(rng.integers(1, 3)))
            else:
                t += period * float(rng.uniform(1.2, 1.6))   # comma: a breath between phrases
        wlen = int(rng.choice([1, 2, 2, 3, 3, 4]))
        for j in range(wlen):
            d = period * float(rng.uniform(0.62, 0.78)) * (1.12 if md["legato"] else 1.0)
            vowel = (str(rng.choice(_DIPH)) if rng.uniform() < 0.18 else str(rng.choice(list(prof["vowels"]))))
            pc = [0.10, 0.16, 0.1, 0.14, 0.1, 0.08, 0.04, 0.08, 0.07, 0.06, 0.05, 0.02]
            if prof["smooth"] > 0:  # smooth voices prefer soft onsets
                pc = [p * (1.8 if c in ("", "m", "n", "l", "h") else 0.6) for p, c in zip(pc, _CONS)]
            if prof["bubbly"] > 0:
                pc = [p * (1.6 if c in ("b", "p", "d") else 1.0) for p, c in zip(pc, _CONS)]
            pc = np.asarray(pc) / np.sum(pc)
            cons = str(rng.choice(_CONS, p=pc))
            syl.append(dict(t=t, d=d, st=0.0, vowel=vowel, cons=cons, amp=1.0, breathy=0.0, hes=False,
                            word_start=(j == 0)))
            count += 1
            t += period * float(rng.uniform(0.92, 1.06))
            if limit_n and count >= limit_n:
                break
            if limit_t and t + period > limit_t:
                break
        if (limit_n and count >= limit_n) or (limit_t and t + period > limit_t):
            break
        t += period * float(rng.uniform(0.35, 0.65))       # space between 'words'
    # sentence contour over the spoken (non-hesitation) syllables
    spoken = [s for s in syl if not s.get("hes")]
    n = len(spoken)
    walk = 0.0
    for i, s in enumerate(spoken):
        pos = i / max(1, n - 1)
        walk = 0.6 * walk + float(rng.uniform(-1.0, 1.0)) * 0.9
        st = md["decl"] * (pos - 0.5) + walk * rng_st * 0.8
        if s.get("word_start"):
            st += 0.9 * rng_st
        if shape == "bounce":
            st += (1.4 if i % 2 == 0 else -0.6) * rng_st
        if shape == "bored":
            st = md["decl"] * pos + 0.35 * walk
        if shape == "exclaim" or exclaim:
            st += 4.0 * rng_st * math.exp(-((pos - 0.3) / 0.18) ** 2)
        s["st"] = st + md["pitch"]
    if spoken:
        last = spoken[-1]
        if question or shape == "question":
            if n >= 2:
                spoken[-2]["st"] += 2.0 * rng_st
            last["st"] += 3.5 * rng_st
            last["glide"] = 3.0 * rng_st
            last["d"] *= 1.35
        elif shape == "whiny":
            last["d"] *= 2.2
            last["glide"] = -1.5
        elif shape in ("statement", "bored", "hesitant"):
            last["st"] -= 1.5 * rng_st
            last["glide"] = -1.2
        if exclaim and not question:
            last["d"] *= 0.85
            last["glide"] = -2.0
    for s in syl:
        if s.get("hes"):
            s["st"] += md["pitch"] - 1.0
            s["glide"] = -1.5
    return syl, md


# -------------------------------------------------------------------------------------------- synthesis
def _svf(x, fc, q, sr, mode):
    n = x.shape[0]
    fc = np.full(n, float(fc)) if np.isscalar(fc) else np.asarray(fc, dtype=np.float64)
    q = np.full(n, float(q)) if np.isscalar(q) else np.asarray(q, dtype=np.float64)
    return dsp._svf(np.ascontiguousarray(x, dtype=np.float64), fc, q, float(sr), dsp._MODES[mode])


def _syllable(s, prof, md, sr, rng):
    d = s["d"]
    n = max(16, int(d * sr))
    tt = np.arange(n) / sr
    f0 = prof["base_hz"] * 2.0 ** (s["st"] / 12.0)
    g = s.get("glide", 0.0)
    shape = np.clip(tt / d, 0.0, 1.0)
    pitch_st = -0.6 * np.exp(-tt / 0.012) + g * shape ** 1.5          # small scoop in, optional glide out
    if prof["wobble"] > 0:
        pitch_st += 0.32 * prof["wobble"] * np.sin(TWO_PI * 9.0 * tt + float(rng.uniform(0, 6)))
    if md["shape"] == "whiny":
        pitch_st += 0.4 * np.sin(TWO_PI * 7.0 * tt) * np.clip(tt / 0.05, 0, 1)
    f = f0 * 2.0 ** (pitch_st / 12.0)
    f *= 1.0 + 0.008 * dsp._onepole(rng.uniform(-1, 1, n), 1.0 - math.exp(-TWO_PI * 30.0 / sr))
    # source
    if prof["electronic"] > 0:
        src = dsp._pulse(f, np.full(n, 0.32), float(sr), float(rng.uniform()))
        src = np.round(src * 6) / 6 * prof["electronic"] + dsp._saw(f, float(sr), 0.0) * (1 - prof["electronic"])
    else:
        src = dsp._saw(f, float(sr), float(rng.uniform()))
    if prof["growl"] > 0:
        sub = dsp._saw(f * 0.5, float(sr), 0.0)
        rough = 1.0 + 0.35 * prof["growl"] * np.sin(TWO_PI * float(rng.uniform(38, 55)) * tt)
        src = (src + 0.35 * prof["growl"] * sub) * rough
    src = _svf(src, 1900.0 * prof["brightness"], 0.6, sr, "lp")
    br = prof["breath"] + s.get("breathy", 0.0)
    if br > 0:  # breath sits in a band (no hiss on top)
        src = src + _svf(rng.uniform(-1, 1, n), 2400.0, 0.7, sr, "bpn") * br * 2.0
    # formant trajectory (single vowel, or a diphthong gliding over the blip)
    v = s["vowel"]
    a = np.asarray(_VOW[v[0]], dtype=np.float64)
    b = np.asarray(_VOW[v[-1]], dtype=np.float64)
    mix = np.clip((shape - 0.3) / 0.6, 0.0, 1.0)[:, None] if len(v) > 1 else np.zeros((n, 1))
    traj = (a[None, :] * (1 - mix) + b[None, :] * mix) * prof["formant"]
    y = np.zeros(n)
    for k in range(4):
        fc = traj[:, k]
        y += _FG[k] * _svf(src, fc, fc / (_BW[k] * (0.8 + 0.2 * prof["formant"])), sr, "bpn")
    if prof["electronic"] > 0:
        y = 0.55 * y + 0.45 * _svf(src, 2600.0, 0.7, sr, "lp")
    # envelope: blippy for normal speech, softer for legato/smooth voices
    att = 0.004 if prof["bubbly"] > 0 else (0.009 if (md["legato"] or prof["smooth"] > 0.5) else 0.006)
    rel = 0.016 if not md["legato"] else 0.024
    env = np.minimum(tt / att, 1.0) * np.clip((d - tt) / rel, 0.0, 1.0)
    if s.get("hes"):
        env *= np.interp(shape, [0, 0.2, 1.0], [0.6, 1.0, 0.4])
    if s["cons"] == "h":
        env *= np.interp(shape, [0, 0.18, 1.0], [0.5, 1.0, 0.35])
    y *= env * s["amp"] * md["energy"]
    # consonant tick in front of the vowel
    c = s["cons"]
    if c in ("b", "p", "d", "t", "k", "g", "s"):
        fc = {"b": 900.0, "p": 1100.0, "d": 3200.0, "t": 3800.0, "k": 2000.0, "g": 1700.0, "s": 5200.0}[c]
        ln = 0.008 if c == "s" else 0.004
        m = int(ln * sr)
        tick = _svf(rng.uniform(-1, 1, m), fc, 1.2, sr, "bpn") * np.exp(-np.arange(m) / (0.0012 * sr))
        level = (0.16 if c == "s" else 0.3) * (1.0 - 0.6 * prof["smooth"])
        y[:m] += tick * level
    elif c in ("m", "n", "l"):
        m = min(n, int(0.014 * sr))
        hum = _svf(src[:m], 280.0 * prof["formant"], 4.0, sr, "bpn") * np.linspace(0.6, 0.0, m)
        y[:m] = y[:m] * np.linspace(0.3, 1.0, m) + hum * 0.4
    return y


def speak(length, who="tuan", mood="neutral", seed=0, sr=48000, *, max_dur=None, question=None, exclaim=None,
          hesitate=None, breaks=None):
    """Render one line of animalese. See the module docstring for the contract.
    breaks: optional [(pos 0..1, 'comma'|'hesitate'), ...] phrase breaks (see layout()); taken from text if str."""
    prof = who if isinstance(who, dict) else PROFILES.get(who) or voice_profile(str(who), 220.0)
    rng = np.random.default_rng(int(seed) & 0x7FFFFFFF)
    q = e = h = False
    n_target = None
    dur_target = None
    lay = []
    if isinstance(length, str):
        q, e, h = _flags(length)
        lay = layout(length)
        visible = sum(1 for ch in length if not ch.isspace() and ch not in "…。，,.!！?？、")
        dur_target = float(np.clip(0.11 * visible + 0.25, 0.35, 3.0))
    elif isinstance(length, (int, np.integer)) and not isinstance(length, bool):
        n_target = max(1, int(length))
    else:
        dur_target = max(0.12, float(length))
    q = question if question is not None else q
    e = exclaim if exclaim is not None else e
    h = hesitate if hesitate is not None else h
    if max_dur is not None and dur_target is not None:
        dur_target = min(dur_target, float(max_dur))
    if breaks is not None:
        lay = list(breaks)
    plan, md = _plan(n_target, dur_target, mood, prof, (q, e, h), rng, lay)
    # fit the plan inside the requested span (and max_dur), keeping rhythm proportions
    end = max(s["t"] + s["d"] for s in plan) + 0.02
    cap = dur_target if dur_target is not None else None
    if max_dur is not None:
        cap = min(cap, max_dur) if cap is not None else max_dur
    if cap is not None and end > cap:
        k = cap / end
        for s in plan:
            s["t"] *= k
            s["d"] *= max(k, 0.7)
        end = max(s["t"] + s["d"] for s in plan) + 0.02
        if end > cap:  # durations floored at 70%: trim the tail syllables instead
            plan = [s for s in plan if s["t"] + s["d"] + 0.02 <= cap] or plan[:1]
            end = max(s["t"] + s["d"] for s in plan) + 0.02
    total = int(math.ceil(end * sr)) + 1
    out = np.zeros(total)
    for s in plan:
        y = _syllable(s, prof, md, sr, rng)
        i = int(round(s["t"] * sr))
        m = min(y.shape[0], total - i)
        out[i:i + m] += y[:m]
    out = dsp._dcblock(out, 0.9995)
    out = _svf(out, 6800.0, 0.6, sr, "lp")       # cute, never fizzy
    out = dsp._onepole(out, 1.0 - math.exp(-TWO_PI * 9000.0 / sr))
    pk = float(np.max(np.abs(out)))
    if pk > 1e-9:
        out *= 0.8 / pk
    if max_dur is not None:
        out = out[: int(max_dur * sr)]
    nfade = min(out.shape[0], int(0.006 * sr))
    if nfade > 1:
        out[-nfade:] *= np.linspace(1.0, 0.0, nfade)
    p = (min(max(prof["pan"], -1.0), 1.0) + 1.0) * math.pi / 4.0
    return np.stack([out * math.cos(p), out * math.sin(p)], axis=1)


def speak_line(line, beat_s, film, index, sr=48000):
    """Cue-sheet convenience: fill ~85% of the line's beat budget, punctuation from zh/en, seeded by film+index."""
    budget = float(line.get("beats", 2)) * beat_s
    mood = line.get("mood", "neutral")
    fill = {"laugh": 0.9, "bored": 0.88, "whiny": 0.9}.get(mood, 0.85)
    q, e, h = _flags(line.get("zh") or line.get("en") or "")
    qe, ee, he = _flags(line.get("en") or "")
    lay = layout(line.get("zh") or line.get("en") or "")
    return speak(budget * fill, line.get("who", "tuan"), mood, line_seed(film, index), sr, max_dur=budget * 0.97,
                 question=q or qe, exclaim=e or ee, hesitate=h or he, breaks=lay)
