# Linux Capture Process

The Linux sidecar keeps the shared Native Client contract while delegating
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

Runtime requirements are the desktop Portal/PipeWire services, a GStreamer
PipeWire source, and an installed GStreamer hardware H.264 encoder. If any part
is unavailable, the Client reports no Linux Native path and the same Browser
capture choice remains available. These system libraries and services are not
bundled; their distribution-provided license notices remain applicable. Linux
Client packages repeat the dependency and source links in
`THIRD-PARTY-NOTICES.txt`.

Primary references:

- <https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html>
- <https://libportal.org/libportal.html>
- <https://pipewire.pages.freedesktop.org/pipewire/page_portal.html>
- <https://gstreamer.freedesktop.org/documentation/>
