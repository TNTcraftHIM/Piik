# Diagnostic Feedback

Reviewed 2026-09-09. [Configuration](../reference/configuration.md#diagnostics)
owns current activation, contents, bounds and disclosure. This note records the
references and integration decisions; it is not another logging API contract.

## Mature References

| Reference | Verified practice | Applied here |
| --- | --- | --- |
| [OBS application logging](https://github.com/obsproject/obs-studio/blob/012c6c23c73283ee5591ae00d08af14d9eeb8279/frontend/obs-main.cpp) | Session logs and separate crash/profiler reports retain diagnostic context; repetition and retention are managed. | Preserve selected startup facts, bounded history and related report files. OBS implementation is study-only; no GPL code is copied. |
| [Chromium WebRTC internals](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/content/browser/webrtc/webrtc_internals.cc) and [dump export](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/content/browser/webrtc/resources/dump_creator.js) | Connection/capture API events and RTCStats are kept together with timestamps and Browser context. Raw dumps can contain sensitive URLs/configuration. | Observe existing connection owners and stats samples; include requested versus applied settings and errors. Do not copy raw dumps as a redaction policy. |
| [Tailscale bug reports](https://tailscale.com/docs/account/bug-report) | A timestamped marker associates the report with health/network context; record mode can bracket reproduction. | Put a marker and current runtime metadata into a local bundle. No cloud collector, device account or support backend is needed. |

## Smallest Coherent Integration

The existing Go recorder, rotating file, ZIP writer, runtime memory statistics
and pprof snapshots remain. Existing Browser diagnostic recording and Native
request IDs remain the owning surfaces. Complete the missing evidence at those
boundaries instead of constructing a second application event bus.

Native async request completion is recorded by the existing completion owner.
Capture subprocess stderr is a bounded line stream alongside its existing media
pipe, with no media/wire format change. Windows reads its existing VSE observer
on input processing cadence; no diagnostic callback chooses bitrate or routes.
Browser state listeners attach at current PeerConnection creation sites and
consume existing stats calls; no global prototype replacement or new poller is
introduced. Export-time platform metadata has a bounded wait and can fail
without deleting the event history.

Pion's existing logger factory and LiveKit's LogR adapter feed the same slog
handler. Existing Zap object/array marshalers retain RTP/BWE fields that plain
JSON would otherwise silently encode as empty objects. Critical credential
filtering precedes persistence. Pinned Pion formats include named ICE secrets,
space-separated ufrag extensions, hexadecimal username comparisons and an opaque
remote-track dump; those forms need explicit handling, not just URL filtering.
Other technical identities and network/system details are disclosed as residual
information rather than promised to be fully anonymous.

Optional profile failures produce a partial report with a file/error manifest.
The ZIP still fails if its destination cannot be written. Whole-process memory,
screen/audio recording, remote collection and a crash-uploader service add cost
and disclosure beyond the diagnostic result; none is required by this design.

## Verification Boundary

Focused checks exercise split stderr chunks, actual Pion secret formats,
structured media statistics, log rotation/reopen and partial export. Existing
Native/Browser owner checks retain asynchronous setting and media behavior.
Physical acceptance must inspect an exported bundle from the running code, not
only assert that instrumentation methods were called. A report is not guaranteed
to reconstruct events that occurred before Debug was enabled or outside its
explicit retained history.
