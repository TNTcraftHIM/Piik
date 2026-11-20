# Sharing and playback

This guide covers the 3.0 internal test. For the published version, use the [stable documentation](https://piik.tv/docs/?lang=en).

English · [简体中文](./sharing.zh-CN.md) · [Documentation](./README.md)

To open a site or create a room, start with [getting started](./getting-started.md).
Each admitted participant can share in a room; several people can share at once.
You choose which pictures to watch.

[Watch a webpage video together](#watch-a-webpage-video-together)

## Start or change a share

1. Select the room, then **Start sharing** in its header.
2. Choose **Browser**, **Camera**, or an App window/screen where available.
   Select the source and its sound options. An App picker may ask you to finish
   the selection in the App.
3. Check your local preview. Friends see your share under **Available to watch**
   and select **Watch** to receive it.

Screen sharing on iPhone/iPad requires Safari on iOS/iPadOS 27 or later.
Watching and camera sharing are separate capabilities. Safari screen capture
does not include system sound; see the [browser compatibility record](https://github.com/mdn/browser-compat-data/pull/30732).

![Source picker with example app windows and the source-audio switch.](../assets/guide/channel-source.en.png#gh-light-mode-only)
![Source picker with example app windows and the source-audio switch.](../assets/guide/channel-source.en.dark.png#gh-dark-mode-only)

Use **Switch source** on your picture card to replace that share. You can also share
in another room without ending the first share. Switching the sidebar selection
keeps existing shares, watched pictures and voice running, including playback sound.
The main area shows only the selected room's pictures. The activity strip lists
pictures in other rooms: **Return** opens their room, while **Stop watching** or
**Stop sharing** ends only the selected activity.
Hiding a picture releases its remote control; return to that room and request control again when needed.

Send the site address or a public-room link for ordinary access. Private rooms
use their own invitation or password; send those invitations only to intended
guests. Each room owner manages that room's access and invitation resets;
see [getting started](./getting-started.md).

## Share video and audio from OBS

1. Open Piik App on the computer running OBS. In the room, select **Start sharing → OBS / WHIP**.
2. In OBS, open **Settings → Stream** and set **Service** to **WHIP**. Copy **Server** and **Bearer Token** from Piik into the matching fields in OBS. [OBS settings screenshot](https://obsproject.com/kb/whip-streaming-guide)
3. Set OBS to use **H.264** video and **Opus** audio, then select **Start Streaming**. Once Piik shows the OBS picture is live, viewers can select **Watch** in the room.

If Piik reports an unsupported video format, stop streaming, select **NV12** under **Settings → Advanced → Video → Color Format**, then start streaming again. Some Linux builds of OBS stay on “Connecting.” To share through the virtual camera instead, start it in OBS and follow [Cameras and virtual audio inputs](#cameras-and-virtual-audio-inputs) to set up video and sound.

## Watch a webpage video together

In a 3.0 test room, select **Start sharing → Watch together** and paste a direct video URL or copy the page address from your browser’s address bar.

- **Direct video link or YouTube.** Select **Play direct video URL** or, for YouTube, **Watch together**. Everyone can use a browser. Each person plays the video from its original source.
- **Watch on the original webpage.** In the Windows App, select **Open webpage and select video**. Sign in on the website if needed and play the video. Return to Piik, select the player and choose **Share original webpage only**. If the player has a **Choose playback source** button, use it to see the options. Each viewer uses Piik App on Windows and selects **Open webpage and select video** in the room. Piik opens the page the sharer chose. Each viewer signs in with their own account if needed and selects the player. The webpage then appears inside the room’s main picture. The sharer controls play, pause and seeking for everyone.
- **Forward to a viewer in a browser.** For a video you can share, open **Choose playback source** and select **Forward through App**. Viewers can select **Receive from sharer**. The video uses the sharer’s internet upload bandwidth and needs a working media connection to the viewers. If access expires, the sharer restores playback on the original website, then the viewer selects **Retry** beside the error.

If you're already watching a shared webpage video in the Windows App, open **Playback settings → Open webpage and select video** to use the website's player. The current video keeps playing while you choose. Select the player to switch, or close the chooser to keep watching in Piik. When the source supports direct playback, use **Playback settings → Play directly from website** to return to Piik's player. For YouTube, press Play in the preview to switch.

With direct links, YouTube and original webpages, each viewer loads the video from its origin. A cloud tunnel used to reach the room carries the playback controls and position. To switch episodes, the sharer selects **Switch source** and viewers join the new activity.

## Share settings

Before starting, open **Share settings → Picture** beside **Start sharing**.
During a share, use the same control on that picture's card. If you are browsing
another room, use **Return** in the activity strip first. Choose a
preset, or expand **Fine-tune picture** to set resolution, frame rate and bitrate.
Choose the video codec before starting the share. Available codecs depend on
the browser or connected App.

![Share settings with presets and a separate section for detailed picture controls.](../assets/guide/channel-quality.en.png#gh-light-mode-only)
![Share settings with presets and a separate section for detailed picture controls.](../assets/guide/channel-quality.en.dark.png#gh-dark-mode-only)

- **Resolution** is a ceiling; portrait and ultrawide sources keep their proportions.
- **Sliders** offer common values. Type another allowed value in the field;
  **Use common range** returns to the slider's range.
- **Sound** contains source audio quality and, during a share, your commentary controls.

Piik adapts the picture within these limits according to the source, device and
connection. Platform support is listed in the [Native reference](../../prototype/channel-native/README.md).

### Name your share

Your share uses the selected source's name when available. In its **Share settings**,
expand **Share title**, enter a name and **Save**. Your title stays when you switch
sources. Clear the field and save to use the current source name again.

### Include your microphone

During a share, enable **Share settings → Sound → Include my microphone** to
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
then select that input under **Share settings → Sound → Include my microphone**.
Its sound travels with the picture. Turn off voice processing for music or
virtual audio that has already been processed.

## Exclude a voice app from screen audio

When a connected Windows App offers audio exclusion, **Screens → System sound**
can exclude a selected application's process tree. **Apps / Windows** instead
captures the selected application's sound where supported.

1. In **Screens**, enable **System sound**.
2. Under **Exclude application audio**, choose the voice application's window.
   Open its window and refresh the list if it is missing.
3. Select the screen. While sharing, the supported live controls remain in
   **Share settings → Sound**.

Other applications or mixers can still carry that sound. If your voice remains
audible after muting the Piik microphone, turn off source sound to check whether
it comes through a mixer's playback or monitoring. Share just the application's
audio or use a different playback device when exclusion is unavailable.

## Playback controls

### Watch and arrange pictures

Select **Watch** beside a person's share. You can keep watches in several rooms;
the main area arranges the current room's pictures. Select a tile or **Focus** to
enlarge one; **Grid view** or **Return to grid** shows that room's other pictures.

The eye beside each share shows how many people are watching it. Both the sharer
and viewers can select it to see the names.

Move the pointer over a picture or tap it to reveal its playback bar.

| Control | What it changes |
| --- | --- |
| Play / pause | Only your local playback. |
| Volume | Your listening for a remote picture. On your own preview, source volume changes the shared sound for viewers; the preview stays muted locally. |
| Playback settings | Local fit, rotation and on-screen chat appearance. |
| Theater mode | Expands the focused picture inside the tab. |
| Picture in picture / Fullscreen | Opens the browser's supported video window or fullscreen view. |
| Mini window | Keeps the room's people, conversation and voice controls beside the picture; see [room tools](./room-tools.md#keep-the-room-beside-a-picture-or-game). |

Pictures labelled **Local preview** stay silent to avoid playing the source sound
twice. Adjust shared volume on the page that started the share.

## Finish one activity

- **Stop watching** closes that picture for you; it does not stop its source or other pictures.
- **Pause sharing** on your own tile pauses that share for its viewers; **Resume sharing** continues it.
- **Stop sharing** ends that source and its commentary; it does not end room chat or your joined voice rooms.

To leave voice, use its separate **Leave voice** control. Keep the App and page
needed for your current activities open; [getting started](./getting-started.md)
explains Browser and App room hosting.
