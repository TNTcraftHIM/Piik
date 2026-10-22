# Sharing and playback

English · [简体中文](./sharing.zh-CN.md) · [Documentation](./README.md)

Start with [your first room](./getting-started.md). This guide covers the picture
and source sound you share, plus controls that affect only your own viewing.

## Picture and sound settings

1. Below the picture, open **Sharing settings → Picture**.
2. Choose a preset. Use **Fine-tune picture** only when you need a specific
   resolution, frame rate, bitrate, picture preference or codec.
3. Open **Sound** to choose the source audio and its output quality.

![Sharing settings on the Picture tab, with presets above the collapsed fine-tuning controls.](../assets/guide/sharing-settings.en.png#gh-light-mode-only)
![Sharing settings on the Picture tab, with presets above the collapsed fine-tuning controls.](../assets/guide/sharing-settings.en.dark.png#gh-dark-mode-only)

*Actual controls with sample settings. Start with a preset; expand only what you need.*

| Setting | What to expect |
| --- | --- |
| Resolution | A ceiling. Portrait and ultrawide sources keep their proportions. |
| Slider or custom value | Sliders cover common values. Type within the field's allowed range for other values; **Use common range** returns to a nearby slider value. |
| Picture and sound quality | Both still adapt to the source, device and available bandwidth. |

Applied settings are remembered for the current site. Opening Piik through an
updated App also keeps sharing-quality settings when a public-invite address changes.

## Cameras and virtual audio inputs

Picture sound and conversation use separate controls. Muting one does not mute the other.

![Source sound travels with the shared picture and uses video volume. A microphone travels through room voice and uses voice listening controls.](../assets/guide/audio-paths.en.svg)

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

Move the pointer over the picture or tap it to show the playback bar.

| You want to… | Use… | Who is affected? |
| --- | --- | --- |
| Pause watching or mute source sound | The playback bar on the picture | Only you. The Host's preview starts muted. |
| Pause the picture for friends | **Pause sharing**, below the picture | Everyone watching. |
| Mute your microphone or stop hearing voices | **Interact → Voice** | Your voice controls; separate from picture sound. |

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
