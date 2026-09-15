# Linux Capture Process

The Linux sidecar keeps the shared Native App contract while delegating
desktop integration to the standard Linux media stack. XDG Desktop Portal owns
the screen/window choice, PipeWire supplies the selected stream, and GStreamer
selects an installed element classified as a hardware H.264 video encoder.
Piik adds only the current product profile, Annex-B access-unit framing,
key-frame requests, and the bounded `SMED` output protocol.

The Portal restore token remains in the active share process and lets a live
quality change reacquire the same selected source without inventing a second
source picker. System playback audio uses the PipeWire PulseAudio compatibility
service when its GStreamer source is installed. Per-process audio is not
advertised.

Build on a Linux desktop with development packages for libportal and GStreamer:

```sh
sh native/capture/linux/build.sh /outside/repository/build
```

Run `npm run check:native` on Linux to compile the sidecar, run the headless
output-profile and retirement regression, and validate its probe/source list.
The same check runs when the Linux CI job packages an App candidate. For the
native build and regression alone, add `--check` to the command above. The test
uses GStreamer's core synthetic elements and needs no display, Portal session,
capture device or hardware encoder; physical capture remains a separate check.

Output retirement already closes a branch's valve before stopping its elements.
Encoder failures currently remain fatal to the capture run, including failures
reported for one output. Isolating those failures also requires containing
GStreamer queue/tee flow errors before they reach sibling branches; changing only
the asynchronous bus handler is insufficient. Keep state retirement off streaming
callbacks and verify sibling output, source failure and shutdown on Linux before
changing this boundary. [TODO](../../../docs/todo.md) tracks that remaining work.

Runtime requirements are the desktop Portal/PipeWire services, a GStreamer
PipeWire source, and an installed GStreamer hardware H.264 encoder. If any part
is unavailable, the App reports no Linux Native path and the same Browser
capture choice remains available. These system libraries and services are not
bundled; their distribution-provided license notices remain applicable. Linux
App packages repeat the dependency and source links in
`THIRD-PARTY-NOTICES.txt`.

Primary references:

- <https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html>
- <https://libportal.org/libportal.html>
- <https://pipewire.pages.freedesktop.org/pipewire/page_portal.html>
- <https://gstreamer.freedesktop.org/documentation/>
