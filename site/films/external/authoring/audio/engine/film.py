"""Film soundtrack pipeline shared by every film: score -> music stem, cue SFX -> sfx stem, cue lines -> voice stem,
then mastering, stems and QA report. A film's build.py only supplies its cue sheet, its compose() and a FilmMix.
"""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from .core import SR, Bus, Grid, db, load_cues, write_wav, to_db
from . import dsp, fx, qa, voice
from . import sfx as sfxlib
from .arrange import Arranger


# ------------------------------------------------------------------------------------------ track defaults
def default_process(name: str, x: np.ndarray) -> np.ndarray:
    """Per-track tone shaping by naming convention (kick, snare, hat, bass, ep, gtr, brass, strings, lead...)."""
    if name.startswith("kick"):
        x = fx.hp(x, 32.0, order=2)
        x = fx.eq(x, [("peak", 350.0, -2.5, 1.0), ("peak", 3200.0, 2.0, 1.2)])
    elif name in ("snare", "clap", "rim"):
        x = fx.hp(x, 100.0)
    elif name in ("hat", "ohat", "shaker", "perc_x", "cym"):
        x = fx.hp(x, 450.0 if name != "cym" else 300.0)
        x = fx.lp(x, 12000.0)
    elif name.startswith("bass"):
        x = fx.hp(x, 32.0, order=2)
        x = fx.eq(x, [("low", 55.0, -1.5, 0.7), ("peak", 900.0, 1.5, 1.0)])
        x = fx.comp(x, threshold_db=-20.0, ratio=3.5, attack_ms=8.0, release_ms=110.0, makeup_db=3.0)
        x = fx.lp(x, 6500.0)
        x = np.repeat(x.mean(axis=1, keepdims=True), 2, axis=1)
    elif name == "ep":
        x = fx.hp(x, 110.0)
        x = fx.eq(x, [("peak", 320.0, -2.0, 0.9)])
        x = fx.autopan(x, rate=4.4, depth=0.28)
        x = fx.chorus(x, rate=0.7, depth=0.18, mix=0.3)
    elif name == "gtr":
        x = fx.hp(x, 230.0)
        x = fx.lp(x, 7500.0)
        x = np.stack([x.mean(axis=1) * 0.8, x.mean(axis=1) * 1.15], axis=1)
    elif name == "brass":
        x = fx.hp(x, 140.0)
        x = fx.comp(x, threshold_db=-16.0, ratio=2.5, attack_ms=3.0, release_ms=90.0)
        x = fx.eq(x, [("high", 8000.0, -1.5, 0.7), ("peak", 450.0, -1.5, 1.0)])
    elif name == "strings":
        x = fx.eq(x, [("peak", 420.0, -2.0, 0.9)])
        x = fx.lp(x, 9000.0)
    elif name == "lead":
        x = fx.hp(x, 200.0)
        x = fx.lp(x, 8500.0)
        x = fx.eq(x, [("peak", 2600.0, 1.0, 1.0)])
    elif name in ("glock", "bells"):
        x = fx.hp(x, 500.0)
    elif name == "trombone":
        x = fx.hp(x, 90.0)
    elif name in ("timp", "tom"):
        x = fx.hp(x, 40.0)
    return x


@dataclass
class FilmMix:
    """Mix decisions for one film. Gains/sends are dB; unknown tracks default to -12 dB with no sends."""
    title: str
    length: float
    gains: dict
    send_room: dict = field(default_factory=dict)
    send_plate: dict = field(default_factory=dict)
    send_delay: dict = field(default_factory=dict)
    delay_beats: float = 0.75
    sidechain: dict = field(default_factory=dict)
    swing: float = 0.5
    line_duck_db: float = 4.0
    line_duck_extra: dict = field(default_factory=dict)   # mood -> extra dB
    voice_gain: dict = field(default_factory=dict)        # mood -> dB
    sfx_duck_db: float = 2.0
    sfx_bus_db: float = 0.0
    voice_bus_db: float = 0.0
    tv_intro: tuple | None = None    # ([bar,beat] sweep start, [bar,beat] fully open)
    no_tv: set = field(default_factory=set)
    crackle_db: float | None = None
    fade: tuple | None = None        # (start_s, end_s): music fades to silence
    target_lufs: float = -14.0
    ceiling_dbtp: float = -1.0
    process: Callable = default_process
    chords: dict = field(default_factory=dict)  # bar -> symbol, for the harmony table
    sfx_level: dict = field(default_factory=dict)   # per-film default-level overrides (dB) by SFX name
    voice_engine: str = "voice"   # "voice" (pinyin babble, legacy) | "animalese" (language-neutral)
    film_id: str = ""            # seeds animalese lines: line_seed(film_id, index)
    hit_tracks: tuple = ("kick", "brass", "snare", "timp")  # parts that define cue hits (QA only)
    sc_hold: float = 0.02
    sc_release: float = 0.12
    post_main: Callable | None = None   # (main, grid) -> main; runs after reverbs/TV, before glue + gates


# -------------------------------------------------------------------------------------------- helpers
def tv_filter(x: np.ndarray, t_sweep: float, t_open: float) -> np.ndarray:
    """Music heard 'through a TV' until t_sweep, opening to full range by t_open, then crossfade to dry."""
    n_end = int((t_open + 0.12) * SR)
    seg = x[:n_end].copy()
    t = np.arange(n_end) / SR
    s = np.clip((t - t_sweep) / (t_open - t_sweep), 0.0, 1.0) ** 2
    hp_c = 520.0 * (22.0 / 520.0) ** s
    lp_c = 2700.0 * (21000.0 / 2700.0) ** s
    y = dsp.svf(seg, hp_c, 0.7, "hp")
    y = dsp.svf(y, lp_c, 0.85, "lp")
    mono = np.repeat(y.mean(axis=1, keepdims=True), 2, axis=1)
    y = mono * (1 - s)[:, None] + y * s[:, None]
    sat = dsp.soft_clip(y * 1.8, 1.0) / 1.8
    y = sat * (1 - s)[:, None] + y * s[:, None]
    gain = db(-6.0) * (1 - s) + 1.0 * s
    y *= gain[:, None]
    xf = np.clip((t - t_open) / 0.1, 0.0, 1.0)[:, None]
    out = x.copy()
    out[:n_end] = y * (1 - xf) + seg * xf
    return out


def gate(n: int, windows) -> np.ndarray:
    """1 outside windows, 0 inside; 8 ms fade-out ending exactly at each window start, 2 ms fade-in ending at its end."""
    g = np.ones(n)
    for t0, t1 in windows:
        i0, i1 = int(round(t0 * SR)), int(round(t1 * SR))
        fo, fi = int(0.008 * SR), int(0.002 * SR)
        g[i0 - fo:i0] *= np.linspace(1.0, 0.0, fo)
        g[i0:i1 - fi] = 0.0
        g[i1 - fi:i1] *= np.linspace(0.0, 1.0, fi)
    return g


def crackle_bed(seconds: float, until: float) -> np.ndarray:
    rng = np.random.default_rng(99)
    n = int(seconds * SR)
    m = int(until * SR)
    hiss = dsp.svf(dsp.pink(m, rng) * 3.0, 2600.0, 0.6, "bpn") * 0.05
    crk = np.zeros(m)
    k = int(until * 35)
    pos = rng.integers(0, m, k)
    crk[pos] = rng.uniform(0.2, 1.0, k) * rng.choice([-1, 1], k)
    crk = dsp.svf(crk, 3000.0, 0.9, "bpn") * 0.5
    y = hiss + crk
    y *= np.minimum(np.arange(m) / (0.05 * SR), 1.0)
    y[-int(0.08 * SR):] *= np.linspace(1, 0, int(0.08 * SR))
    out = np.zeros((n, 2))
    out[:m, 0] = y
    out[:m, 1] = np.roll(y, 37)
    return out


# ---------------------------------------------------------------------------------------------- stems
def render_music(cues, grid: Grid, compose: Callable, mx: FilmMix, log) -> np.ndarray:
    a = Arranger(grid, mx.length, seed=11)
    meta = compose(a) or {}
    n = int(mx.length * SR)
    exempt = set(meta.get("stop_exempt", []))
    sc_curve = fx.sidechain(n, sorted(a.kick_times + a.sc_extra), depth_db=1.0, hold=mx.sc_hold, release=mx.sc_release)
    main, post_tv, hitref, ex = (np.zeros((n, 2)) for _ in range(4))
    room_in, plate_in, plate_ex, delay_in = (np.zeros((n, 2)) for _ in range(4))
    stats = {}
    for name, bus in a.tracks.items():
        x = mx.process(name, bus.x) * db(mx.gains.get(name, -12.0))
        if name in mx.sidechain:
            curve = 10 ** ((20 * np.log10(sc_curve + 1e-9)) * mx.sidechain[name] / 20.0)
            x = x * curve[:, None]
        if name.startswith("kick") or name in mx.hit_tracks:
            hitref += x
        stats[name] = (to_db(float(np.sqrt((x ** 2).mean()) + 1e-12)), to_db(float(np.abs(x).max()) + 1e-12))
        (ex if name in exempt else (post_tv if name in mx.no_tv else main))[:] += x
        if name in mx.send_room:
            room_in += x * db(mx.send_room[name])
        if name in mx.send_plate:
            (plate_ex if name in exempt else plate_in)[:] += x * db(mx.send_plate[name])
        if name in mx.send_delay:
            delay_in += x * db(mx.send_delay[name])
    main += fx.reverb(room_in, size=0.24, damping=0.6, width=0.85, hp_hz=250.0, lp_hz=8000.0)
    main += fx.reverb(plate_in, size=0.58, damping=0.5, width=1.0, predelay_ms=15.0, hp_hz=300.0, lp_hz=7500.0)
    if mx.send_delay:
        main += fx.delay(delay_in, grid.beat * mx.delay_beats, feedback=0.3, mix_lp=4500.0, hp_hz=350.0)
    ex += fx.reverb(plate_ex, size=0.5, damping=0.5, width=1.0, hp_hz=300.0, lp_hz=7000.0)
    if mx.tv_intro:
        t_open = grid.pos(mx.tv_intro[1])
        main = tv_filter(main, grid.pos(mx.tv_intro[0]), t_open)
        if mx.crackle_db is not None:
            main += crackle_bed(mx.length, t_open) * db(mx.crackle_db)
    main += post_tv
    if mx.post_main is not None:
        main = mx.post_main(main, grid)
    main = fx.comp(main, threshold_db=-14.0, ratio=2.0, attack_ms=15.0, release_ms=160.0)
    windows = [(grid.pos(s["from"]), grid.pos(s["to"])) for s in cues.get("stops", [])]
    main *= gate(n, windows)[:, None]
    music = main + ex
    regions = []
    for ln in cues.get("lines", []):
        t0 = grid.pos(ln["at"])
        depth = mx.line_duck_db + mx.line_duck_extra.get(ln.get("mood"), 0.0)
        regions.append((t0 - 0.03, t0 + ln.get("beats", 2) * grid.beat + 0.08, depth))
    for ev in cues.get("sfx", []):
        if ev["name"] in sfxlib.BIG:
            t0 = grid.pos(ev["at"])
            regions.append((t0, t0 + 0.22, mx.sfx_duck_db))
    music *= fx.gain_curve(n, regions, attack=0.03, release=0.18)[:, None]
    music = fx.eq(music, [("high", 10500.0, -1.0, 0.7)])
    if mx.fade:
        t = np.arange(n) / SR
        fs, fe = mx.fade
        fcurve = np.where(t < fs, 1.0, np.cos(np.clip((t - fs) / (fe - fs), 0, 1) * math.pi / 2) ** 2)
        music *= fcurve[:, None]
    log["tracks"] = stats
    log["hitref"] = hitref
    return music


def render_sfx(cues, grid: Grid, mx: FilmMix, log) -> np.ndarray:
    bus = Bus(mx.length, "sfx")
    events = []
    for k, ev in enumerate(cues.get("sfx", [])):
        name = ev["name"]
        t0 = grid.pos(ev["at"])
        kw = {"seed": k}
        for key in ("note", "pitch"):
            if key in ev:
                kw[key] = ev[key]
        if "until" in ev:
            kw["dur"] = grid.pos(ev["until"]) - t0
        clip = sfxlib.SFX[name](**kw)
        gain = mx.sfx_level.get(name, sfxlib.LEVEL.get(name, -6.0)) + ev.get("gain", 0.0)
        bus.add(clip, t0, gain)
        events.append((t0, name, ev, gain, clip.shape[0] / SR))
    x = fx.hp(bus.x, 34.0, order=2)
    x = fx.eq(x, [("low", 65.0, -2.0, 0.7)])
    x = x + fx.reverb(x * db(-14.0), size=0.38, damping=0.55, width=0.9, hp_hz=350.0, lp_hz=8000.0)
    x = fx.lp(x, 15000.0)
    log["sfx_events"] = events
    return x * db(mx.sfx_bus_db)


def render_voice(cues, grid: Grid, mx: FilmMix, log) -> np.ndarray:
    bus = Bus(mx.length, "voice")
    lines = []
    for k, ln in enumerate(cues.get("lines", [])):
        t0 = grid.pos(ln["at"])
        if mx.voice_engine == "animalese":
            from . import animalese

            clip = animalese.speak_line(ln, grid.beat, mx.film_id, k)
        else:
            clip = voice.render_line(ln, grid.beat, seed=31 + k)
        bus.add(clip, t0, mx.voice_gain.get(ln.get("mood"), 0.0) - 3.0)
        lines.append((t0, ln, clip.shape[0] / SR, ln.get("beats", 2) * grid.beat))
    x = fx.hp(bus.x, 120.0)
    x = fx.lp(x, 9500.0)
    x = fx.comp(x, threshold_db=-20.0, ratio=3.0, attack_ms=4.0, release_ms=80.0, makeup_db=2.0)
    x = x + fx.reverb(x * db(-16.0), size=0.25, damping=0.6, width=0.7, hp_hz=300.0, lp_hz=7000.0)
    log["lines"] = lines
    return x * db(mx.voice_bus_db)


# --------------------------------------------------------------------------------------------- build
def build(cues_path, out_dir, compose: Callable, mx: FilmMix) -> dict:
    t_start = time.time()
    cues = load_cues(cues_path)
    grid = Grid.from_cues(cues, swing=mx.swing)
    out_dir = Path(out_dir)
    log = {}
    music = render_music(cues, grid, compose, mx, log)
    sfx = render_sfx(cues, grid, mx, log)
    vox = render_voice(cues, grid, mx, log)
    n = int(mx.length * SR)
    assert music.shape[0] == sfx.shape[0] == vox.shape[0] == n
    mix, info = fx.master(music + sfx + vox, target_lufs=mx.target_lufs, ceiling_dbtp=mx.ceiling_dbtp)
    gain = db(info["gain_db"])
    stems = {"music": music * gain, "sfx": sfx * gain, "voice": vox * gain}
    peak = max(float(np.abs(s).max()) for s in stems.values())
    stem_scale = 1.0
    if peak > db(-0.5):
        stem_scale = db(-0.5) / peak
        stems = {k: v * stem_scale for k, v in stems.items()}
    out_dir.mkdir(parents=True, exist_ok=True)
    for k, v in stems.items():
        write_wav(out_dir / f"{k}.wav", v)
    write_wav(out_dir / "mix.wav", mix)
    info["render_s"] = time.time() - t_start
    report(cues, grid, mx, log, mix, stems, info, stem_scale, out_dir)
    return info


def report(cues, grid, mx: FilmMix, log, mix, stems, info, stem_scale, out_dir: Path):
    hits = [grid.pos(h) for h in cues.get("hits", [])]
    stops = [(grid.pos(s["from"]), grid.pos(s["to"])) for s in cues.get("stops", [])]
    bars = cues["bars"]
    qa.spectrogram(mix, out_dir / "spectrogram.png", f"{mx.title} — mix", grid=grid, bars=bars)
    qa.rms_plot(stems, out_dir / "rms.png", grid=grid, bars=bars, hits=hits, stops=stops)
    L = []
    w = L.append
    w(f"{mx.title} — soundtrack report")
    w(f"render time {info['render_s']:.1f} s; length {mix.shape[0] / SR:.3f} s ({mix.shape[0]} samples @ {SR} Hz), "
      f"{grid.bpm} BPM, swing {mx.swing}")
    w(f"mix: integrated {info['lufs']:.2f} LUFS, true peak {info['true_peak_dbtp']:.2f} dBTP, master gain {info['gain_db']:.2f} dB")
    w(f"stems written at master gain{'' if stem_scale == 1 else f' x {to_db(stem_scale):.2f} dB safety'} (pre-limiter, sum ≈ mix)")
    for k, v in stems.items():
        w(f"  {k:6s} peak {to_db(float(np.abs(v).max())):6.2f} dBFS   true peak {fx.true_peak_db(v):6.2f} dBTP   LUFS {fx.lufs(v):6.2f}")
    w("DC offset mix L/R: %.2e / %.2e" % (float(mix[:, 0].mean()), float(mix[:, 1].mean())))
    w("band balance (dB rel. total): " + "  ".join(f"{k} {v:.1f}" for k, v in qa.band_balance(mix).items()))
    w("")
    w("track RMS / peak (dBFS, after gain, pre-bus):")
    for k, (r, p) in sorted(log["tracks"].items()):
        w(f"  {k:10s} rms {r:7.2f}  peak {p:7.2f}")
    w("")
    w("stop windows (music stem must be silent except stop-exempt parts):")
    for (a, b), s in zip(stops, cues.get("stops", [])):
        w(f"  {s['from']}->{s['to']}  {a:7.3f}-{b:7.3f}s  music RMS {qa.window_rms_db(stems['music'], a + 0.01, b - 0.005):7.1f} dBFS"
          + (f"  ({s['note']})" if "note" in s else ""))
    w("")
    w("hit check (attack start of kick+brass+snare+timp near each cue hit; deviation in ms):")
    for h, t in zip(cues.get("hits", []), hits):
        on = qa.onset_first(log["hitref"], t)
        w(f"  [{h[0]:2d},{h[1]}]  {t:7.3f}s  onset {on:7.3f}s  dev {1000 * (on - t):+6.1f} ms")
    w("")
    w("harmony check: strongest pitch classes per bar (music stem, 90 Hz-2.2 kHz; harmonics fold in) vs chart:")
    for bar in range(1, bars + 1):
        pcs = qa.chroma_top(stems["music"], grid.t(bar), grid.t(bar + 1), k=4)
        w(f"  bar {bar:2d}  chart {str(mx.chords.get(bar, '-')):18s} top {' '.join(pcs)}")
    w("")
    w("dialogue vs music (RMS in each line window, after ducking):")
    for t0, ln, dur, budget in log["lines"]:
        vr = qa.window_rms_db(stems["voice"], t0, t0 + dur)
        mr = qa.window_rms_db(stems["music"], t0, t0 + dur)
        w(f"  {t0:7.3f}s {ln['who']:5s} voice {vr:6.1f}  music {mr:6.1f}  diff {vr - mr:+5.1f} dB")
    w("")
    w("SFX events (peak = event peak in sfx stem; last column = peak minus music RMS around the event):")
    w("  time      cue          name           params                  level   len    peak   vs music")
    for t0, name, ev, gain, dur in log["sfx_events"]:
        extra = " ".join(f"{k}={ev[k]}" for k in ("note", "pitch", "until", "gain") if k in ev)
        pk = qa.peak_db(stems["sfx"], t0, t0 + min(dur, 0.3) + 0.01)
        mr = qa.window_rms_db(stems["music"], t0 - 0.05, t0 + 0.25)
        cue = f"[{ev['at'][0]},{ev['at'][1]}]"
        w(f"  {t0:7.3f}s  {cue:11s}  {name:14s} {extra:22s} {gain:+5.1f}  {dur:.2f}s  {pk:6.1f}  {max(-99.0, min(99.0, pk - mr)):+6.1f}")
    w("")
    w("dialogue lines (babble):")
    for t0, ln, dur, budget in log["lines"]:
        cue = f"[{ln['at'][0]},{ln['at'][1]}]"
        w(f"  {t0:7.3f}s  {cue:8s}  {ln['who']:5s} {ln.get('mood', ''):6s} len {dur:.2f}s / budget {budget:.2f}s  {ln['zh']}")
    (out_dir / "report.txt").write_text("\n".join(L), encoding="utf-8")
    # machine-readable sync sheet for the picture side (seconds + 60 fps frame of every sound event)
    ev = [{"t": round(t0, 6), "frame60": round(t0 * 60), "cue": e["at"], "name": name, "len": round(dur, 3)}
          for t0, name, e, gain, dur in log["sfx_events"]]
    ev += [{"t": round(t0, 6), "frame60": round(t0 * 60), "cue": ln["at"], "name": "line:" + ln["who"],
            "text": ln["zh"], "len": round(dur, 3)} for t0, ln, dur, budget in log["lines"]]
    (out_dir / "events.json").write_text(json.dumps(sorted(ev, key=lambda e: e["t"]), ensure_ascii=False, indent=1),
                                         encoding="utf-8")
