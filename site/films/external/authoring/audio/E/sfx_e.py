"""Film E chiptune SFX and text-blip voices, registered into the shared SFX library at import time
(the engine files themselves are untouched). Names are prefixed e_ so they never collide with A/B/C."""
from __future__ import annotations

import numpy as np

from engine.core import SR, to_stereo
from engine import sfx as sfxlib
from engine import dsp
import chip as C


def _cat(*parts):
    return np.concatenate([p for p in parts if p is not None and len(p)])


def _mix(*items):
    """items: (clip, start_s, gain) → summed mono."""
    n = max(int(round(s * SR)) + c.shape[0] for c, s, g in items)
    out = np.zeros(n)
    for c, s, g in items:
        i = int(round(s * SR))
        out[i:i + c.shape[0]] += c * g
    return out


def arp(notes, step=0.03, duty=0.25, vol=0.5, tail=0.06, **kw):
    return _mix(*[(C.pulse_note(n, step + (tail if k == len(notes) - 1 else 0.0), duty, vol, d=0.05, s=0.5, r=0.02, **kw), k * step, 1.0)
                  for k, n in enumerate(notes)])


# --------------------------------------------------------------------------------------------- the sounds
def e_room_in(**_):
    return arp([69, 72, 76, 81], 0.09, 0.125, 0.3, tail=0.4)

def e_glitch(seed=0, **_):
    rng = np.random.default_rng(5 + seed)
    parts = [(C.pulse_note(int(rng.integers(60, 96)), 0.02, 0.5, 0.35, d=0.01, s=0.4, r=0.005), k * 0.022, 1.0) for k in range(7)]
    parts.append((C.noise_env(0.15, 9000.0, 0.05, 0.4, short=True), 0.0, 1.0))
    return _mix(*parts)

def e_swirl(dur=1.4, **_):
    n = int(dur * SR)
    notes = list(range(96, 52, -2))
    step = dur * 0.75 / len(notes)
    down = _mix(*[(C.pulse_note(nt, step * 1.5, 0.25, 0.32, d=0.03, s=0.5, r=0.01), k * step, 1.0) for k, nt in enumerate(notes)])
    up = C.noise_env(dur, 2000.0, dur, 0.28, rate_end=26000.0)
    out = np.zeros(n)
    out[: min(n, down.shape[0])] += down[:n]
    out[: min(n, up.shape[0])] += up[:n] * np.linspace(0.2, 1.0, min(n, up.shape[0]))
    return dsp.endfade(out, 8.0)

def e_flash(**_):
    return _mix((C.noise_env(0.18, 30000.0, 0.05, 0.6), 0, 1.0), (C.pulse_note(96, 0.06, 0.5, 0.3, d=0.03, s=0.3), 0, 1.0))

def e_boss_drop(**_):
    thud = C.tri_note(40, 0.3, 1.0, slide=14)
    thud *= np.exp(-np.arange(thud.shape[0]) / (0.12 * SR))
    return _mix((thud, 0, 1.0), (C.noise_env(0.25, 4000.0, 0.08, 0.55), 0, 1.0))

def e_hpfill(dur=0.4, **_):
    k = max(4, int(dur / 0.025))
    return _mix(*[(C.pulse_note(64 + i, 0.02, 0.125, 0.22, d=0.01, s=0.6, r=0.004), i * dur / k, 1.0) for i in range(k)])

def e_menu_open(pitch=0, **_):
    return arp([88 + pitch, 93 + pitch], 0.035, 0.25, 0.32)

def e_menu_move(**_):
    return C.pulse_note(96, 0.025, 0.25, 0.3, d=0.015, s=0.4, r=0.008)

def e_select(**_):
    return arp([91, 96], 0.04, 0.5, 0.33, tail=0.05)

def e_hit_tiny(**_):
    return _mix((C.noise_env(0.06, 18000.0, 0.015, 0.4), 0, 1.0), (C.pulse_note(84, 0.03, 0.5, 0.25, slide=-5, d=0.02, s=0.2), 0, 1.0))

def e_yawn(**_):
    body = C.pulse_note(60, 0.9, 0.5, 0.42, a=0.06, d=0.3, s=0.8, r=0.15, bend_to=48, vib=60, vib_rate=5.0, vib_delay=0.2)
    breath = C.noise_env(1.0, 3000.0, 0.5, 0.12)
    return _mix((body, 0, 1.0), (breath, 0.05, 1.0))

def e_stat_down(**_):
    return arp([76, 72, 69, 64], 0.045, 0.5, 0.33, tail=0.1)

def e_stat_up(note=76, **_):
    return arp([note, note + 4, note + 7, note + 12], 0.03, 0.25, 0.3, tail=0.05)

def e_share(**_):
    sweep = C.pulse_note(60, 0.35, 0.125, 0.3, a=0.01, d=0.3, s=0.8, r=0.05, bend_to=84)
    return _mix((sweep, 0, 1.0), (arp([84, 88, 91, 96, 100], 0.04, 0.25, 0.28, tail=0.2), 0.22, 1.0))

def e_live(**_):
    a = C.pulse_note(84, 0.12, 0.25, 0.28, d=0.1, s=0.5, r=0.05) + C.pulse_note(88, 0.12, 0.5, 0.2, d=0.1, s=0.5, r=0.05)
    return _mix((a, 0, 1.0), (C.pulse_note(91, 0.25, 0.25, 0.3, d=0.2, s=0.5, r=0.1, vib=20), 0.13, 1.0))

def e_letter(**_):
    return _mix((C.noise_env(0.12, 8000.0, 0.04, 0.3, rate_end=16000.0), 0, 1.0), (C.pulse_note(88, 0.04, 0.25, 0.25, d=0.03, s=0.3), 0.02, 1.0))

def e_whoosh(pitch=0, **_):
    return C.noise_env(0.22, 4000.0 * 2 ** (pitch / 12), 0.09, 0.35, rate_end=20000.0 * 2 ** (pitch / 12))

def e_portal(**_):
    sw = _mix(*[(C.pulse_note(72 + (k * 5) % 24, 0.03, 0.125, 0.22, d=0.02, s=0.5, r=0.01), k * 0.025, 1.0) for k in range(14)])
    return _mix((sw, 0, 1.0), (C.noise_env(0.4, 6000.0, 0.25, 0.18, rate_end=24000.0), 0, 1.0))

def e_join(note=72, **_):
    """Party-join fanfare: original 4-note rising figure with a bass hit (do-mi-sol-do over the root)."""
    lead = _mix((C.pulse_note(note, 0.07, 0.25, 0.38, d=0.05, s=0.6, r=0.02), 0, 1.0),
                (C.pulse_note(note + 4, 0.07, 0.25, 0.38, d=0.05, s=0.6, r=0.02), 0.075, 1.0),
                (C.pulse_note(note + 7, 0.07, 0.25, 0.38, d=0.05, s=0.6, r=0.02), 0.15, 1.0),
                (C.pulse_note(note + 12, 0.28, 0.25, 0.4, d=0.2, s=0.6, r=0.08, vib=18), 0.225, 1.0))
    harm = _mix((C.pulse_note(note - 5, 0.07, 0.5, 0.18, d=0.05, s=0.6, r=0.02), 0.0, 1.0), (C.pulse_note(note + 7 - 12, 0.3, 0.5, 0.2, d=0.2, s=0.6, r=0.08), 0.225, 1.0))
    bass = C.tri_note(note - 24, 0.45, 0.6)
    return _mix((lead, 0, 1.0), (harm, 0, 1.0), (bass, 0, 1.0))

def e_tag(pitch=0, **_):
    return arp([86 + pitch, 91 + pitch], 0.03, 0.125, 0.25)

def e_turn(**_):
    return arp([84, 91], 0.05, 0.25, 0.3, tail=0.08)

def e_voice(dur=1.6, **_):
    n = int(dur * SR)
    warble = C.pulse_note(79, dur * 0.85, 0.125, 0.18, a=0.05, d=0.2, s=0.8, r=0.1, vib=90, vib_rate=9.0, vib_delay=0.0)
    chirps = _mix(*[(C.pulse_note(88 + (k % 3) * 3, 0.04, 0.25, 0.18, d=0.03, s=0.3, r=0.01), k * dur / 8, 1.0) for k in range(8)])
    out = np.zeros(n)
    for c in (warble, chirps):
        m = min(n, c.shape[0]); out[:m] += c[:m]
    return dsp.endfade(out, 10.0)

def e_dmk(pitch=0, **_):
    return _mix((C.noise_env(0.07, 16000.0, 0.02, 0.38), 0, 1.0), (C.pulse_note(84 + pitch, 0.035, 0.25, 0.22, d=0.02, s=0.3, r=0.01), 0, 1.0))

def e_super(**_):
    stab = sum(C.pulse_note(n, 0.22, 0.25, 0.2, d=0.15, s=0.5, r=0.08) for n in (84, 88, 91))
    return _mix((stab, 0, 1.0), (C.noise_env(0.4, 24000.0, 0.15, 0.35), 0, 1.0), (C.tri_note(48, 0.25, 0.6), 0, 1.0))

def e_throw(**_):
    return C.pulse_note(72, 0.36, 0.125, 0.3, a=0.01, d=0.3, s=0.8, r=0.03, bend_to=96)

def e_splat(**_):
    sq = C.pulse_note(60, 0.14, 0.5, 0.35, d=0.1, s=0.2, r=0.03, bend_to=40)
    return _mix((C.noise_env(0.25, 5000.0, 0.07, 0.6), 0, 1.0), (sq, 0, 1.0))

def e_boss_laugh(**_):
    return _mix(*[(C.pulse_note(n, 0.12, 0.5, 0.36, d=0.08, s=0.6, r=0.04, vib=40, vib_delay=0.0), k * 0.15, 1.0) for k, n in enumerate((55, 52, 48))])

def e_kb_pass(dur=0.4, **_):
    k = 10
    return _mix(*[(C.pulse_note(72 + i * 2, 0.025, 0.25, 0.25, d=0.015, s=0.4, r=0.005), i * dur / k, 1.0) for i in range(k)],
                (C.noise_env(dur, 5000.0, dur, 0.15, rate_end=25000.0), 0, 1.0))

def e_cutin(**_):
    stab = sum(C.pulse_note(n, 0.3, 0.25, 0.2, d=0.2, s=0.6, r=0.1) for n in (81, 84, 88))
    return _mix((C.noise_env(0.5, 3000.0, 0.25, 0.4, rate_end=30000.0), 0, 1.0), (stab, 0.02, 1.0), (C.tri_note(45, 0.3, 0.7), 0, 1.0))

def e_charge(dur=1.2, **_):
    n = int(dur * SR)
    up = C.pulse_note(57, dur * 0.95, 0.125, 0.22, a=0.05, d=dur, s=1.0, r=0.03, bend_to=93, vib=30, vib_rate=11.0, vib_delay=0.0)
    nz = C.noise_env(dur, 3000.0, dur * 2, 0.18, rate_end=36000.0)
    out = np.zeros(n)
    for c in (up, nz):
        m = min(n, c.shape[0]); out[:m] += c[:m] * np.linspace(0.3, 1.0, m)
    return dsp.endfade(out, 6.0)

def e_combo(pitch=0, **_):
    stab = sum(C.pulse_note(n + pitch, 0.12, 0.5, 0.18, d=0.08, s=0.4, r=0.04) for n in (76, 81, 84))
    return _mix((C.noise_env(0.22, 12000.0, 0.06, 0.55), 0, 1.0), (stab, 0, 1.0), (C.kick(0.8), 0, 1.0))

def e_combo_big(**_):
    stab = sum(C.pulse_note(n, 0.5, 0.25, 0.2, d=0.3, s=0.5, r=0.2) for n in (76, 80, 83, 88))
    boom = C.tri_note(28, 0.5, 1.0, slide=20)
    boom *= np.exp(-np.arange(boom.shape[0]) / (0.18 * SR))
    return _mix((C.noise_env(0.9, 9000.0, 0.3, 0.6, rate_end=2000.0), 0, 1.0), (stab, 0, 1.0), (boom, 0, 1.0))

def e_defeat(**_):
    exp = C.noise_env(1.6, 12000.0, 0.6, 0.6, rate_end=900.0)
    fall = arp(list(range(88, 52, -3)), 0.05, 0.5, 0.22, tail=0.1)
    return _mix((exp, 0, 1.0), (fall, 0.15, 1.0), (C.kick(1.0), 0, 1.0))

def e_lvup(note=72, **_):
    return arp([note, note + 4, note + 7, note + 12, note + 16], 0.03, 0.25, 0.28, tail=0.12)

def e_item(**_):
    """'Got an item!' — original: a quick rising triad + a held, shimmering octave."""
    return _mix((arp([84, 88, 91], 0.06, 0.25, 0.32), 0, 1.0), (C.pulse_note(96, 0.5, 0.25, 0.32, d=0.4, s=0.6, r=0.2, vib=22), 0.18, 1.0),
                (C.pulse_note(91, 0.5, 0.5, 0.16, d=0.4, s=0.6, r=0.2), 0.18, 1.0), (C.tri_note(60, 0.6, 0.55), 0.18, 1.0))

def e_wipe(**_):
    return C.noise_env(0.4, 2000.0, 0.3, 0.3, rate_end=22000.0)

def e_row(pitch=0, **_):
    return arp([84 + pitch, 91 + pitch], 0.025, 0.125, 0.24, tail=0.03)

def e_sparkle(seed=0, **_):
    rng = np.random.default_rng(31 + seed)
    return _mix(*[(C.pulse_note(int(rng.choice([96, 98, 100, 103, 105])), 0.04, 0.125, 0.16, d=0.03, s=0.3, r=0.02), 0.045 * k, 1.0) for k in range(7)])

def e_start(**_):
    return arp([84, 96], 0.06, 0.5, 0.25, tail=0.06)

# text blips: (duty, base MIDI, pitch spread, length, wobble)
VOICES = {"sys": (0.5, 81, (0, 2, 4, 7), 0.032, 0.0), "tuan": (0.25, 76, (0, 2, 4, 7, 9), 0.04, 0.0),
          "yuan": (0.25, 81, (0, 3, 5, 7, 10), 0.036, 0.0), "dian": (0.125, 84, (0, 2, 4, 7, 9, 12), 0.03, 0.0),
          "cong": (0.5, 74, (0, 2, 5, 7), 0.045, 35.0), "boss": (0.5, 57, (0, 3, 5), 0.06, 25.0)}

def _blip(who):
    duty, base, spread, ln, wob = VOICES[who]
    def f(note=None, seed=0, **_):
        n = base + spread[seed % len(spread)] if note is None else note
        if who == "boss":
            y = C.tri_note(n, ln, 0.8) * np.exp(-np.arange(int(round((ln + 0.015) * SR))) / (0.03 * SR))
            return y
        return C.pulse_note(n, ln, duty, 0.3, a=0.001, d=ln, s=0.3, r=0.01, vib=wob, vib_delay=0.0, vib_rate=14.0)
    return f


SFX_E = {k: v for k, v in globals().items() if k.startswith("e_") and callable(v)}
for _w in VOICES:
    SFX_E[f"e_blip_{_w}"] = _blip(_w)
LEVEL_E = {k: -8.0 for k in SFX_E}
LEVEL_E.update({"e_boss_drop": -3.0, "e_combo_big": -2.0, "e_defeat": -3.0, "e_join": -4.0, "e_super": -4.0, "e_cutin": -4.0,
                "e_menu_move": -6.0, "e_menu_open": -6.0, "e_select": -5.0, "e_row": -5.0, "e_tag": -7.0, "e_hit_tiny": -4.0,
                "e_swirl": -5.0, "e_charge": -7.0, "e_item": -4.0, "e_lvup": -6.0, "e_stat_up": -6.0, "e_room_in": -8.0,
                "e_yawn": -4.0, "e_stat_down": -5.0, "e_splat": -4.0, "e_throw": -6.0, "e_dmk": -5.0, "e_voice": -7.0,
                "e_boss_laugh": -4.0, "e_share": -5.0, "e_live": -5.0, "e_portal": -7.0, "e_combo": -4.0, "e_kb_pass": -6.0})
for _w in VOICES:
    LEVEL_E[f"e_blip_{_w}"] = -6.5
BIG_E = {"e_boss_drop", "e_super", "e_cutin", "e_combo_big", "e_defeat", "e_flash"}

sfxlib.SFX.update(SFX_E)
sfxlib.LEVEL.update(LEVEL_E)
sfxlib.BIG |= BIG_E
