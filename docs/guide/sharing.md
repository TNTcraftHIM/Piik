# Sharing and playback

This guide covers the 3.0 internal test. For the published version, use the [2.6.0 guide](https://github.com/TNTcraftHIM/Piik/blob/v2.6.0/docs/guide/sharing.md).

English · [简体中文](./sharing.zh-CN.md) · [Documentation](./README.md)

To enter a domain or create a room, start with [getting started](./getting-started.md).
Each admitted participant can share in a room; several people can share at once.
You choose which pictures to watch.

## Start or change a share

1. Select the room, then **Start sharing** in its header.
2. Choose **Browser**, **Camera**, or an App window/screen where available.
   Select the source and its sound options. An App picker may ask you to finish
   the selection in the App.
3. Check your local preview. Friends see your share under **Available to watch**
   and select **Watch** to receive it.

Use **Switch source** to replace your picture in that room. You can also share
in another room without ending the first share. Switching the sidebar selection
keeps existing shares, watched pictures and voice running.

Domain and room invitations are different: the domain invitation opens the
domain, while a room invitation leads to that room and can grant its access.
Use the corresponding copy or QR control and send private invitations only to
intended guests. Domain and room owners manage their own access, passwords and
invitation resets; see [getting started](./getting-started.md).

## Picture and sound settings

Open **Picture and sound → Picture** beside your sharing control. Choose a
preset, or expand **Fine-tune picture** to set resolution, frame rate and bitrate.
Choose the video codec before starting the share. Available codecs depend on
the browser or connected App.

- **Resolution** is a ceiling; portrait and ultrawide sources keep their proportions.
- **Sliders** offer common values. Type another allowed value in the field;
  **Use common range** returns to the slider's range.
- **Sound** contains source audio quality and, during a share, your commentary controls.

The applied limits do not guarantee a particular received picture quality;
the source, device and connection still matter. Native platform support is
listed in the [Native reference](../../prototype/channel-native/README.md).

### Include your microphone

During a share, enable **Picture and sound → Sound → Include my microphone** to
add commentary to the picture. Select its input, volume and voice processing
there. The microphone starts off for each new share and ends when it stops.

Viewers hear commentary through the picture without joining room voice.
[Room voice](./room-tools.md#room-voice) remains independent. Enabling both can
deliver your speech twice; choose the one you need.

## Cameras and virtual audio inputs

In **Camera**, allow video access and select a picture card. While one camera
is sharing, the other cameras are listed by name. Select a camera's microphone
separately as commentary or room-voice input.

OBS Virtual Camera supplies video. To include OBS audio, follow the
[OBS audio-routing guide](https://obsproject.com/kb/video-call-streaming-tutorial/),
then select that input in the commentary controls or the separate room-voice settings.

## Exclude a voice app from screen audio

When a connected Windows App offers audio exclusion, **Screens → System sound**
can exclude a selected application's process tree. **Apps / Windows** instead
captures the selected application's sound where supported.

1. In **Screens**, enable **System sound**.
2. Under **Exclude application audio**, choose the voice application's window.
   Open its window and refresh the list if it is missing.
3. Select the screen. While sharing, the supported live controls remain in
   **Picture and sound → Sound**.

Other applications or mixers can still carry that sound. If your voice remains
audible after muting the Piik microphone, turn off source sound to check whether
it comes through a mixer's playback or monitoring. Share just the application's
audio or use a different playback device when exclusion is unavailable.

## Playback controls

### Watch and arrange pictures

Select **Watch** beside a person's share. You can watch several pictures,
including pictures from different rooms. Select a tile or **Focus** to enlarge
one; **Grid view** or **Return to grid** shows the others again.

Move the pointer over a picture or tap it to reveal its playback bar.

| Control | What it changes |
| --- | --- |
| Play / pause | Only your local playback. |
| Volume | Your listening for a remote picture. On your own preview, source volume changes the shared sound for viewers; the preview stays muted locally. |
| Playback settings | Local fit, rotation and on-screen chat appearance. |
| Theater mode | Expands the focused picture inside the tab. |
| Picture in picture / Fullscreen | Opens the browser's supported video window or fullscreen view. |
| Mini window | Keeps the room's people, conversation and voice controls beside the picture; see [room tools](./room-tools.md#keep-the-room-beside-a-picture-or-game). |

## Finish one activity

- **Stop watching** closes that picture for you; it does not stop its source or other pictures.
- **Pause sharing** on your own tile pauses that share for its viewers; **Resume sharing** continues it.
- **Stop sharing** ends that source and its commentary; it does not end room chat or your joined voice rooms.

To leave voice, use its separate **Leave voice** control. Keep the App and page
needed for your current activities open; [getting started](./getting-started.md)
explains Browser and App room hosting.
