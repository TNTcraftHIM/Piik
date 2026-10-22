"""Piik promo-film procedural audio engine.

core     timing grid ([bar, beat] -> seconds), stereo buses, WAV I/O
dsp      PolyBLEP oscillators, modulated SVF, envelopes, noise, Karplus-Strong (numba)
drums    synthesised kit;  inst  melodic instruments;  sfx  cue-named sound effects;  voice  babble voices
fx       pedalboard wrappers, sends, sidechain/ducking, loudness + true-peak mastering
arrange  Arranger for pattern/note writing;  film  the shared score/sfx/voice -> stems -> master -> QA pipeline
qa       spectrogram / RMS plots, harmony, onset and level checks
"""
