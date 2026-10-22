# Editable audio sources

These are the supplied Python sources for A/C/D/E/F/G: arrangements and mix
settings, procedural instruments, effects, wordless voices, mastering, reports
and Opus/AAC export. The film cue sheets remain in `../films/<ID>/cues.json`,
alongside the editable picture and strings. Picture and sound use the same beat
positions. No virtual environment, installed package implementation, executable
or intermediate render is retained here.

The sources retain their original production layout. For future rebuilding,
prepare an ignored scratch directory with this `audio/` tree and the retained
`films/` tree as siblings. Each `audio/<ID>/build.py` reads that film's cue sheet
and writes `out/<ID>/audio/` beneath the scratch root. D/E/F/G also invoke the
shared `audio/web_export.py`; A/C use it separately. Keep generated WAV stems,
reports and image plots in that scratch directory. Review regenerated music and
voices before deliberately replacing the runtime's compressed tracks.

The original sources import NumPy, Numba, SciPy, pedalboard and Matplotlib;
loudness measurement uses pyloudnorm and the older voice helper can use pypinyin.
Export requires FFmpeg/ffprobe. The archive records pedalboard 0.9.26,
pyloudnorm 0.2.0 and pypinyin 0.55.0; it does not provide a complete reproducible
dependency lock. Recreate a reviewed environment separately. The supplied
virtual environment and these build sources have not been executed in this
import. Installed dependencies retain their own licenses and are not bundled.

`engine/inst_bc.py` is imported by active C/D/F arrangements and `sfx_bc.py` is
registered by the shared effects library, so both remain necessary despite their
names. The retired film B's arrangement and builder are omitted. Only three
nonessential style-reference comments were changed in the retained sources;
the score and signal-processing code are preserved.

Full fonts and original production tooling remain in the owner-supplied archive
identified by the parent README's SHA-256. Fonts are needed to regenerate text
subsets after a copy change; they are unnecessary for audio synthesis. Runtime
font notices, including all three upstream pixel-font notices, remain under
`../assets/fonts/`. Piik's MIT notice applies to the retained Piik-owned sources.
