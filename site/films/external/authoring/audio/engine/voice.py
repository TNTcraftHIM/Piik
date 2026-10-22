"""Babble voices: generated formant syllables, not speech.

One syllable per CJK character. Vowel colour and consonant onset come from the character's pinyin final/initial
and the pitch contour follows its Mandarin tone, so a line keeps the melody of the sentence while staying
unintelligible and cute. Mood shapes tempo, register and contour; lines are time-fitted into their beat budget.
"""
from __future__ import annotations

import math

import numpy as np

from .core import SR, to_stereo
from . import dsp
from . import fx

TWO_PI = 2.0 * math.pi

# Formant targets (F1..F4, Hz) for a neutral adult voice; each character scales them.
VOWELS = {
    "a": (850, 1220, 2810, 3800), "o": (560, 880, 2600, 3600), "e": (540, 1150, 2650, 3600),
    "E": (520, 1850, 2650, 3700), "i": (290, 2250, 3050, 3900), "u": (330, 720, 2450, 3500),
    "y": (290, 1900, 2350, 3600), "z": (380, 1450, 2700, 3700), "n": (280, 1450, 2550, 3500),
    "N": (300, 1100, 2500, 3400), "m": (260, 1200, 2400, 3400),
}
BW = (90.0, 115.0, 170.0, 240.0)
FGAIN = (1.0, 0.62, 0.30, 0.13)

CHARS = {
    "tuan": dict(f0=185.0, fscale=1.08, breath=0.05, bright=1.0, wobble=0.0, pan=-0.08),
    "yuan": dict(f0=250.0, fscale=1.17, breath=0.15, bright=0.85, wobble=0.0, pan=0.12),
    "dian": dict(f0=320.0, fscale=1.26, breath=0.07, bright=1.1, wobble=0.0, pan=-0.22),
    "cong": dict(f0=150.0, fscale=1.0, breath=0.05, bright=0.95, wobble=1.0, pan=0.22),
}
DEFAULT_CHAR = dict(f0=220.0, fscale=1.1, breath=0.08, bright=1.0, wobble=0.0, pan=0.0)

MOODS = {
    "bored": dict(syl=0.150, f0mul=0.90, rng=0.55, decl=-0.16, amp=0.85, legato=True, vib=0.0, pause=0.30),
    "cocky": dict(syl=0.105, f0mul=1.08, rng=1.35, decl=0.05, amp=1.0, legato=False, vib=0.0, pause=0.12),
    "whiny": dict(syl=0.135, f0mul=1.22, rng=1.10, decl=0.0, amp=0.95, legato=True, vib=45.0, pause=0.22),
    "calm": dict(syl=0.125, f0mul=1.00, rng=0.85, decl=-0.05, amp=0.9, legato=True, vib=0.0, pause=0.26),
    "excited": dict(syl=0.095, f0mul=1.25, rng=1.5, decl=0.04, amp=1.0, legato=False, vib=0.0, pause=0.1),
    "laugh": dict(syl=0.115, f0mul=1.2, rng=0.6, decl=-0.12, amp=0.95, legato=False, vib=0.0, pause=0.1),
    # added for films B / C
    "thinking": dict(syl=0.150, f0mul=0.95, rng=0.6, decl=-0.12, amp=0.8, legato=True, vib=0.0, pause=0.26),
    "cheerful": dict(syl=0.110, f0mul=1.10, rng=1.25, decl=0.06, amp=1.0, legato=False, vib=0.0, pause=0.12),
    "sheepish": dict(syl=0.130, f0mul=0.97, rng=0.7, decl=-0.10, amp=0.75, legato=True, vib=0.0, pause=0.34),
}

# Mandarin tone contours in semitones over the syllable (start, mid, end); exaggerated for cuteness.
TONES = {1: (3.0, 3.0, 3.0), 2: (-0.5, 0.8, 3.4), 3: (-1.6, -4.2, -2.4), 4: (3.6, 0.6, -4.2), 5: (-0.8, -1.2, -1.6)}

INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r",
            "z", "c", "s", "y", "w"]
# initial -> (kind, noise centre Hz, length s)
CONS = {
    "b": ("plos", 900, 0.008), "p": ("asp", 900, 0.035), "d": ("plos", 3500, 0.008), "t": ("asp", 3500, 0.035),
    "g": ("plos", 1800, 0.010), "k": ("asp", 1800, 0.035), "j": ("aff", 3200, 0.03), "q": ("aff", 3200, 0.045),
    "x": ("fric", 3800, 0.05), "zh": ("aff", 2600, 0.028), "ch": ("aff", 2600, 0.045), "sh": ("fric", 2600, 0.055),
    "r": ("son", 0, 0.03), "z": ("aff", 5500, 0.026), "c": ("aff", 5500, 0.045), "s": ("fric", 6000, 0.055),
    "f": ("fric", 5000, 0.045), "h": ("breath", 0, 0.045), "m": ("nas", 0, 0.035), "n": ("nas", 0, 0.035),
    "l": ("son", 0, 0.025),
}
APICAL = {"zh", "ch", "sh", "r", "z", "c", "s"}
PUNCT_PAUSE = {"，": 0.10, ",": 0.10, "、": 0.08, "。": 0.0, "！": 0.0, "!": 0.0, "？": 0.0, "?": 0.0, "；": 0.1,
               "：": 0.08, " ": 0.05}


# --------------------------------------------------------------------------------------------- text analysis
def _split(py: str):
    tone = int(py[-1]) if py[-1].isdigit() else 5
    body = py.rstrip("012345").replace("v", "ü")
    ini = ""
    for c in INITIALS:
        if body.startswith(c):
            ini = c
            body = body[len(c):]
            break
    fin = body
    if ini == "y":
        if fin.startswith("u"):
            fin = "ü" + fin[1:]
        elif fin.startswith("i"):
            pass
        elif fin == "ou":
            fin = "iou"
        elif fin == "e":
            fin = "ie"
        else:
            fin = "i" + fin
        ini = ""
    elif ini == "w":
        fin = {"u": "u", "o": "uo", "ei": "uei", "en": "uen", "eng": "ueng"}.get(fin, "u" + fin if not fin.startswith("u") else fin)
        ini = ""
    elif ini in ("j", "q", "x") and fin.startswith("u"):
        fin = "ü" + fin[1:]
    fin = {"iu": "iou", "ui": "uei", "un": "uen"}.get(fin, fin)
    if ini in ("b", "p", "m", "f") and fin == "o":
        fin = "uo"
    return ini, fin, tone


def _targets(ini, fin):
    nasal = None
    f = fin
    if f.endswith("ng"):
        nasal, f = "N", f[:-2]
    elif f.endswith("n") and len(f) > 1:
        nasal, f = "n", f[:-1]
    table = {
        "a": ["a"], "o": ["o"], "e": ["e"], "i": ["z"] if ini in APICAL else ["i"], "u": ["u"], "ü": ["y"],
        "ia": ["i", "a"], "ua": ["u", "a"], "uo": ["u", "o"], "ie": ["i", "E"], "üe": ["y", "E"],
        "ai": ["a", "i"], "ei": ["E", "i"], "ao": ["a", "u"], "ou": ["o", "u"], "iao": ["i", "a", "u"],
        "iou": ["i", "o", "u"], "uai": ["u", "a", "i"], "uei": ["u", "E", "i"], "er": ["e"],
        "üa": ["y", "E"], "ue": ["u", "e"], "io": ["y", "u"],
    }
    tg = list(table.get(f, ["a"]))
    if nasal == "n" and f == "ia":
        tg = ["i", "E"]
    if nasal == "N" and f == "o":
        tg = ["u"]
    return tg, nasal


def syllables(text: str):
    """Text -> list of tokens: ('syl', initial, targets, nasal, tone) | ('pause', seconds, kind) | ('mark', ch)."""
    from pypinyin import Style, lazy_pinyin

    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "…":
            j = i
            while j < len(text) and text[j] == "…":
                j += 1
            out.append(("pause", 0.0, "hesitate"))
            i = j
            continue
        if "一" <= ch <= "鿿":
            py = lazy_pinyin(ch, style=Style.TONE3, neutral_tone_with_five=True)[0]
            ini, fin, tone = _split(py)
            tg, nasal = _targets(ini, fin)
            out.append(("syl", ini, tg, nasal, tone))
        elif ch in PUNCT_PAUSE:
            if ch in "！!？?":
                out.append(("mark", ch))
            elif PUNCT_PAUSE[ch] > 0:
                out.append(("pause", PUNCT_PAUSE[ch], "comma"))
        i += 1
    return out


# --------------------------------------------------------------------------------------------------- synthesis
def _source(f0, n, char, rng):
    """Glottal-ish source: band-limited saw tilted by a 2-pole low-pass, with jitter + breath."""
    jit = dsp.onepole_lp(rng.uniform(-1, 1, n), 30.0) * 0.012
    f = f0 * (1.0 + jit)
    s = dsp.saw(f, phase=rng.uniform())
    tilt = 1900.0 * char["bright"]
    s = dsp.svf(s, tilt, 0.6, "lp")
    br = dsp.svf(rng.uniform(-1, 1, n), 1600.0, 0.5, "hp") * char["breath"] * 2.5
    return s + br


def _formants(x, traj, fscale):
    """traj: (n, 4) formant frequencies. Parallel normalised band-passes."""
    y = np.zeros(x.shape[0])
    for k in range(4):
        fc = traj[:, k] * fscale
        q = fc / (BW[k] * (0.8 + 0.2 * fscale))
        y += FGAIN[k] * dsp.svf(x, fc, q, "bpn")
    return y


def _traj(n, targets, nasal, start=None):
    """Formant trajectory: optional consonant start -> first vowel (held ~30%) -> later targets -> nasal coda."""
    vt = [VOWELS[t] for t in targets]
    v0 = 0.15 if start is not None else 0.0
    v1 = 0.72 if nasal else 0.92
    pts = ([start] if start is not None else []) + [vt[0]]
    keys = ([0.0] if start is not None else []) + [v0]
    if len(vt) > 1:
        hold = v0 + 0.3 * (v1 - v0)
        pts.append(vt[0])
        keys.append(hold)
        for j, p in enumerate(vt[1:], 1):
            pts.append(p)
            keys.append(hold + (v1 - hold) * j / (len(vt) - 1))
    if nasal:
        pts.append(VOWELS[nasal])
        keys.append(1.0)
    pos = np.linspace(0.0, 1.0, n)
    arr = np.asarray(pts, dtype=np.float64)
    return np.stack([np.interp(pos, keys, arr[:, k]) for k in range(4)], axis=1)


def _consonant(kind, fc, length, next_traj0, char, rng):
    n = max(1, int(length * SR))
    t = np.arange(n) / SR
    nz = rng.uniform(-1, 1, n)
    if kind == "plos":
        y = dsp.svf(nz, fc, 1.2, "bpn") * np.exp(-t / 0.004) * 0.5
    elif kind == "asp":
        b = dsp.svf(nz, fc, 1.2, "bpn") * np.exp(-t / 0.004) * 0.5
        a = dsp.svf(rng.uniform(-1, 1, n), 1800.0, 0.6, "bpn") * np.minimum(t / 0.008, 1.0) * np.exp(-t / 0.02) * 0.22
        y = b + a
    elif kind == "aff":
        y = dsp.svf(nz, fc, 1.6, "bpn") * np.minimum(t / 0.004, 1.0) * np.exp(-t / (length * 0.6)) * 0.3
    elif kind == "fric":
        y = dsp.svf(nz, fc, 1.3, "bpn") * np.sin(np.pi * np.clip(t / length, 0, 1)) * 0.22
    elif kind == "breath":
        traj = np.repeat(np.asarray(next_traj0, dtype=np.float64)[None, :], n, axis=0)
        y = _formants(nz * 0.5, traj, char["fscale"]) * np.sin(np.pi * np.clip(t / length, 0, 1)) * 0.32
    else:  # voiced onsets are handled as formant starts
        y = np.zeros(n)
    return dsp.endfade(y, 2.0)


def _tone_curve(n, tone, rng_mul, extra=0.0):
    s, m, e = TONES.get(tone, TONES[5])
    pos = np.linspace(0.0, 1.0, n)
    st = np.interp(pos, [0.0, 0.5, 1.0], [s, m, e]) * rng_mul + extra
    return 2.0 ** (st / 12.0)


def render_tokens(tokens, who: str, mood: str, budget_s: float | None = None, seed=0):
    """Render a token list to a mono clip; returns (clip, timeline of syllable starts)."""
    char = CHARS.get(who, DEFAULT_CHAR)
    md = dict(MOODS.get(mood, MOODS["calm"]))
    rng = np.random.default_rng(seed)
    syls = [k for k in tokens if k[0] == "syl"]
    nsyl = max(1, len(syls))
    # natural durations
    plan = []
    for k, tok in enumerate(tokens):
        if tok[0] == "syl":
            d = md["syl"] * (0.72 if tok[4] == 5 else 1.0) * rng.uniform(0.93, 1.08)
            plan.append(["syl", d, tok])
        elif tok[0] == "pause":
            d = md["pause"] if tok[2] == "hesitate" else tok[1]
            plan.append(["pause", d, tok])
        else:
            plan.append(["mark", 0.0, tok])
    # emphasis marks apply to previous syllable; whiny/bored stretch the last syllable
    syl_idx = [i for i, p in enumerate(plan) if p[0] == "syl"]
    if syl_idx and mood in ("whiny", "bored"):
        plan[syl_idx[-1]][1] *= 1.7 if mood == "whiny" else 1.35
    gap = -0.012 if md["legato"] else 0.012
    total = sum(p[1] for p in plan) + len(syl_idx) * gap + 0.045
    scale = 1.0
    if budget_s is not None and total > budget_s:
        scale = (budget_s - len(syl_idx) * gap - 0.045) / (total - len(syl_idx) * gap - 0.045)
    clips = []
    t = 0.0
    starts = []
    n_seen = 0
    marks_after = {}
    for i, p in enumerate(plan):
        if p[0] == "mark":
            j = max([k for k in syl_idx if k < i], default=None)
            if j is not None:
                marks_after[j] = p[2][1]
    for i, p in enumerate(plan):
        kind, d, tok = p
        d *= scale
        if kind == "pause":
            t += d
            continue
        if kind == "mark":
            continue
        _, ini, targets, nasal, tone = tok
        pos = n_seen / max(1, nsyl - 1) if nsyl > 1 else 0.0
        n_seen += 1
        decl = 2.0 ** ((md["decl"] * 12.0 * pos) / 12.0)
        extra = 0.0
        amp = md["amp"]
        mark = marks_after.get(i)
        if mark in ("！", "!"):
            extra += 1.2
            amp *= 1.15
        if mark in ("？", "?"):
            tone = 2
            extra += 1.5
        if mood == "cocky":
            extra += 0.9 * (1 if n_seen % 2 else -1) * 0.5
        if mood == "laugh":
            extra += -0.8 * n_seen + rng.uniform(-0.5, 0.5)
        f0 = char["f0"] * md["f0mul"] * decl
        cons = CONS.get(ini)
        c_len = 0.0
        if cons and cons[0] in ("plos", "asp", "aff", "fric", "breath"):
            c_len = min(cons[2] * (0.9 if scale > 0.85 else 0.7), d * 0.45)
        v_len = max(0.045, d - c_len)
        nv = int(v_len * SR)
        start_formants = None
        if ini in ("m", "n"):
            start_formants = VOWELS["m" if ini == "m" else "n"]
        elif ini == "l":
            start_formants = (360, 1300, 2700, 3600)
        elif ini == "r":
            start_formants = (380, 1400, 1900, 3300)
        traj = _traj(nv, targets, nasal, start_formants)
        pitch = f0 * _tone_curve(nv, tone, md["rng"], extra)
        if md["vib"] > 0:
            tt = np.arange(nv) / SR
            pitch *= 2.0 ** (md["vib"] * np.sin(TWO_PI * 7.0 * tt) * np.clip(tt / 0.06, 0, 1) / 1200.0)
        if char["wobble"] > 0:
            tt = np.arange(nv) / SR
            pitch *= 2.0 ** (28.0 * char["wobble"] * np.sin(TWO_PI * 9.0 * tt + rng.uniform(0, 6)) / 1200.0)
        src = _source(pitch, nv, char, rng)
        v = _formants(src, traj, char["fscale"])
        tt = np.arange(nv) / SR
        att = 0.012 if not cons or cons[0] in ("nas", "son") else 0.006
        env = np.minimum(tt / att, 1.0) * np.minimum((v_len - tt) / 0.025, 1.0).clip(0, 1)
        if nasal:
            env *= np.interp(tt / v_len, [0, 0.7, 1.0], [1.0, 1.0, 0.55])
        if mood == "laugh":
            env *= np.interp(tt / v_len, [0, 0.15, 1.0], [0.6, 1.0, 0.2])
        v *= env * amp * (0.85 if tone == 3 else 1.0)
        seg = np.zeros(int((c_len + v_len) * SR) + 1)
        if c_len > 0:
            cn = _consonant(cons[0], cons[1], c_len, traj[0] / 1.0, char, rng)
            seg[: cn.shape[0]] += cn * amp
        ci = int(c_len * SR)
        seg[ci:ci + nv] += v
        clips.append((t, seg))
        starts.append(t)
        overlap = 0.012 if md["legato"] else -0.012  # legato overlaps, staccato leaves a hair of air
        t += c_len + v_len - overlap
    end = max((s + c.shape[0] / SR for s, c in clips), default=0.0) + 0.02
    out = np.zeros(int(end * SR) + 1)
    for s, c in clips:
        i = int(s * SR)
        out[i:i + c.shape[0]] += c[: out.shape[0] - i]
    out = dsp.dc_block(out)
    return out, starts


def render_line(line: dict, beat_s: float, seed=0):
    """Render one cue-sheet line {'who','mood','zh','beats'} to a stereo clip (starts at the line's time)."""
    toks = syllables(line["zh"])
    budget = line.get("beats", 4) * beat_s * 0.94
    who = line["who"]
    mood = line.get("mood", "calm")
    clip, _ = render_tokens(toks, who, mood, budget, seed)
    clip = dsp.normalize_peak(clip, 0.8)
    return to_stereo(clip, CHARS.get(who, DEFAULT_CHAR)["pan"])


# ------------------------------------------------------------------------------------------------ crowd SFX
def _vowel_glide(who, targets, dur, contour, seed, breath_add=0.0):
    char = dict(CHARS.get(who, DEFAULT_CHAR))
    char["breath"] += breath_add
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    traj = _traj(n, targets, None)
    pos = np.linspace(0, 1, n)
    pitch = char["f0"] * 2.0 ** (np.interp(pos, contour[0], contour[1]) / 12.0)
    v = _formants(_source(pitch, n, char, rng), traj, char["fscale"])
    tt = np.arange(n) / SR
    env = np.minimum(tt / 0.03, 1.0) * np.interp(pos, [0, 0.6, 1.0], [1.0, 0.9, 0.0])
    return dsp.normalize_peak(v * env, 0.6)


def crowd(kind: str) -> np.ndarray:
    rng = np.random.default_rng(7 if kind == "ooh" else 8)
    length = 1.0 if kind == "ooh" else 1.4
    out = np.zeros((int(length * SR), 2))
    for k, who in enumerate(("tuan", "yuan", "dian", "cong")):
        pan = CHARS[who]["pan"] * 3.0
        if kind == "ooh":
            off = rng.uniform(0.0, 0.035)
            clip = _vowel_glide(who, ["u", "o"], 0.62, ([0, 0.35, 1.0], [0.0, 5.0, -2.0]), 100 + k, 0.05)
            st = to_stereo(clip, pan)
            i = int(off * SR)
            out[i:i + st.shape[0]] += st[: out.shape[0] - i]
        else:
            t = rng.uniform(0.0, 0.06)
            for s in range(3):
                tg = [["i", "E"], ["u", "a"], ["a", "u"]][(s + k) % 3]
                dur = rng.uniform(0.16, 0.24)
                clip = _vowel_glide(who, tg, dur, ([0, 0.3, 1.0], [5.0, 7.5, 3.0]), 200 + 10 * k + s, 0.04)
                st = to_stereo(clip, pan)
                i = int(t * SR)
                out[i:i + st.shape[0]] += st[: out.shape[0] - i] * (1.0 - 0.18 * s)
                t += dur + rng.uniform(0.04, 0.09)
    if kind == "cheer":
        from . import drums

        for j in range(9):
            c = drums.clap(rng.uniform(0.5, 0.9), seed=400 + j)
            st = to_stereo(c, float(rng.uniform(-0.7, 0.7))) * 0.35
            i = int(rng.uniform(0.05, 1.0) * SR)
            out[i:i + st.shape[0]] += st[: out.shape[0] - i]
    out = fx.hp(out, 140.0)
    return dsp.endfade(out, 20.0)



# ----------------------------------------------------------------------------------------- vocal chops (C)
def chop(note, dur, vowel="a", who="dian", vel=0.8, glide=0.0, vib_cents=12.0, seed=0):
    """Pitched formant 'vocal chop' blip for future-bass hooks: fixed pitch (optional scoop of `glide`
    semitones into the note), one vowel or a two-vowel glide like 'ai'/'ao', soft attack, cute formant scale."""
    from .core import mtof

    char = dict(CHARS.get(who, DEFAULT_CHAR))
    rng = np.random.default_rng(seed)
    n = max(1, int(dur * SR))
    tt = np.arange(n) / SR
    f0 = mtof(note)
    pitch = f0 * 2.0 ** ((glide * np.exp(-tt / 0.02)) / 12.0)
    pitch *= 2.0 ** (vib_cents * np.sin(TWO_PI * 5.5 * tt) * np.clip((tt - 0.08) / 0.1, 0, 1) / 1200.0)
    targets = list(vowel) if len(vowel) > 1 else [vowel]
    traj = _traj(n, targets, None)
    v = _formants(_source(pitch, n, char, rng), traj, char["fscale"] * 1.04)
    env = np.minimum(tt / 0.006, 1.0) * np.clip((dur - tt) / 0.03, 0.0, 1.0)
    return dsp.normalize_peak(dsp.dc_block(v * env), 0.8) * vel
