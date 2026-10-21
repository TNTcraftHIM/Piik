# Sharing and playback

English · [简体中文](./sharing.zh-CN.md) · [Documentation](./README.md)

Start with [your first room](./getting-started.md). This guide covers the picture
and source sound you share, plus controls that affect only your own viewing.

## Picture and sound settings

Open **Sharing settings** below the picture. Choose a picture preset first;
expand **Fine-tune picture** to adjust resolution, frame rate, bitrate, picture
preference or video codec. Resolution is a ceiling: the source keeps its proportions,
including portrait and ultrawide pictures.

Sliders cover common values. To go beyond them, enter a custom value within the
range shown by the field; **Use common range** returns to a nearby slider value.
Under **Sound**, choose the source audio and its output quality. Actual picture
and sound still adapt to the source, device and available bandwidth.

Applied settings are remembered for the current site. Opening Piik through an
updated App also keeps sharing-quality settings when a public-invite address changes.

## Cameras and virtual audio inputs

Camera sharing requests only video permission. In the **Camera** tab, allow
access if asked, then select a picture card. Device names and previews depend
on browser permissions; while a camera is shared, other cameras are listed by name.
A camera with a built-in microphone still needs separate video and audio input
selection. OBS Virtual Camera supplies video only. To include OBS audio, follow
the [OBS audio-routing guide](https://obsproject.com/kb/video-call-streaming-tutorial/),
then choose that input in [room voice’s microphone settings](./room-tools.md#room-voice) and turn it on.
This is the conversation channel, separate from the camera picture and source sound.

## Exclude a voice app from screen audio

On Windows, this control applies to system sound from **Screens**. **Apps / Windows**
captures only the selected application's process tree. **Camera** shares video;
its microphone or virtual audio input uses room voice separately.

On supported Windows Apps, open the **Screens** tab and enable **System sound**.
Under **Exclude application audio**, select a window belonging to the voice app,
then choose the screen to share. Open the app's window and refresh if it is absent.
This excludes one process and its children. Other apps remain audible, including
those playing through other output devices.
It does not mute your Piik microphone or prevent speaker sound reaching a microphone.

If a virtual microphone remains audible with Piik's microphone off, temporarily
turn off **System sound** to compare. If the voice disappears, check the mixer's
playback output and monitoring, or capture only the desired application's window
audio. Excluding a voice app does not also exclude a separate mixer that plays
your processed voice, even through a virtual output device.

While sharing, use **Sharing settings → Sound** to change system sound or the
excluded app without stopping the share. If the app closes or restarts, source
audio stops; refresh the application list and select it again.
Turning source audio off retains the exclusion choice;
select **None** to restore unfiltered system audio. This control requires an updated page and a Windows App
whose capability probe supports process exclusion; it is not a Browser-capture filter.
Windows 10 support depends on system updates and the actual capability check.
If the option is absent, share a single application window or route the voice
app to a different playback device.

## Playback controls

The playback bar changes only your own viewing and listening. Move the pointer
over the picture or tap it to show the bar.
The Host has the same local playback controls; its preview starts muted.
Pausing that preview does not pause the share sent to friends. Use **Pause sharing**
below the picture to pause sharing for everyone.

| Control | What it does |
| --- | --- |
| **Theater mode** | Expands the picture inside the browser tab. |
| **Fullscreen** | Expands the picture to the full screen. |
| **Picture in picture** | Opens a floating video where supported. |
| **Volume** | Goes up to 200% with audio boost, or 100% otherwise. Lower it if the sound distorts. |
| **Playback settings** | **Fit** keeps the whole picture visible; **Fill** crops its edges; **Stretch** fills the area by changing its proportions. Connection settings default to **Auto**; available alternatives depend on the host and site. |
| **Rotate picture** | Switches between portrait and landscape locally, without rotating the device or changing the shared source. |

### Connection preferences

Leave the connection setting on **Auto** unless comparing a specific route.
The choices depend on the Host and site; selecting a route does not make an
unavailable server or blocked network reachable.

On supporting sites, **Playback settings → Connection → Help relay to more
viewers** lets a Viewer volunteer more upload for the current visit. It remains
an ordinary P2P relay; enable it on a stable connection with upload to spare.
This option requires updated Server/Web pages; older sites do not offer it.
