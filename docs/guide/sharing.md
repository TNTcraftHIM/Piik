# Sharing and playback

English · [简体中文](./sharing.zh-CN.md) · [Documentation](./README.md)

Share a game, a window, or your whole screen with friends. You can choose whether they hear the game and whether they hear your microphone.

## Start sharing

1. In the room, select **Start sharing**. If you still need a room, see [the getting started guide](./getting-started.md).
2. Pick what you want friends to see.

   | What to share | What to select |
   | --- | --- |
   | A browser tab, window, or screen | Choose **Browser**, then **Choose what to share**. The options in the next window depend on your browser and device. |
   | A desktop game or an app | With Piik App connected, choose **Apps / Windows** if available and select the game or app. |
   | An entire desktop screen | With Piik App connected, choose **Screens** if available and select the display. |
   | A camera | Choose **Camera**, allow access, and select a camera. |

3. If you chose **Browser**, enable audio if offered and confirm in the browser chooser. For an App window or screen, set **Application sound** or **System sound** if available, then select **Start sharing** at the bottom of Piik's picker.
4. Check your preview and keep the room page open while you share. If you want friends to hear you too, see [how to include your microphone](#include-your-microphone).

For a missing chooser or a share that will not start, see [starting a share](./troubleshooting.md#starting-a-share). If friends see the picture but hear no game sound, see [picture but no source sound](./troubleshooting.md#picture-but-no-source-sound).

![A window is selected in the App picker, with Application sound and Start sharing visible.](../assets/guide/share-source-confirm.en.png#gh-light-mode-only)
![A window is selected in the App picker, with Application sound and Start sharing visible.](../assets/guide/share-source-confirm.en.dark.png#gh-dark-mode-only)

If your preview works but your friend still sees no picture, check [the connection between you and your friend](./no-media-route.md).

## Share from a phone or tablet

- **Android.** Use Piik App on Android 10 or later. Open Piik from the installed App and approve Android's screen-sharing prompt. It shares the whole display and can include sound from apps that allow Android to capture it. [Install and open Piik App](./getting-started.md#share-with-piik-app)
- **iPhone and iPad.** Use Safari on iOS or iPadOS 27 or later for screen sharing. [iPhone and iPad screen sharing](#iphone-and-ipad-screen-sharing)

## Switch, cancel, or stop sharing

- **Switch to a different picture.** Select **Switch source** below the picture and choose what to share next.
- **Cancel while choosing.** Close the Piik picker, or select the cancel option in the browser or system prompt. If you opened the picker from **Switch source**, friends keep seeing the current share.
- **Stop an active share.** Select **Stop sharing** below the picture. On a phone, return to the room page first.

## Invitations

**Copy invite link** grants access to your room. Send it only to intended guests.
Turn off **Skip passwords** beside the link to copy the ordinary room address;
visitors then enter the site passphrase or room password as required.
Invite-only rooms require an invitation credential. Existing invitations remain
valid until you use **Rotate link** or **Revoke link**; both disconnect Viewers
who joined with the old invitation.

## Playback controls

Move the pointer over the picture or tap it to show the playback bar.

- The play/pause button on the picture pauses only your own viewing. If you are sharing, the volume on the picture changes the sound sent to everyone. Your preview stays muted to avoid playing the source twice. If you are watching, the volume changes only what you hear.
- **Pause the picture for friends:** select **Pause sharing** below the picture. This affects everyone watching.
- **Control your microphone and listening:** open **Interact → Voice**. These controls are separate from picture sound.

<div class="guide-control-reference">

| Control | What it does |
| --- | --- |
| **Volume** | Goes up to 200% with audio boost, or 100% otherwise. Lower it if the sound distorts. |
| **Picture fit** | Click to cycle: **Fit** keeps the whole picture visible; **Fill** crops its edges; **Stretch** changes its proportions. |
| **Rotate picture** | Switches between portrait and landscape locally, without rotating the device or changing the shared source. |
| **Theater mode** | Expands the picture inside the browser tab. |
| **Picture in picture** | Opens a floating video where supported. |
| **Fullscreen** | Expands the picture to the full screen. |
| **Playback settings** | Adjust on-screen chat and connection preferences. Connections default to **Auto**; available alternatives depend on the host and site. |

</div>

### Connection preferences

Leave the connection setting on **Auto** for ordinary use. To compare routes,
select one of the alternatives offered by the Host and site.

The Host can set **Sharing settings → Connection settings → Room relay limit**. It is
the default number of outgoing copies per device, not the room's Viewer limit.

Viewers follow that default. In **Playback settings → Connection**, enable
**Custom relay limit** to choose a lower or higher limit for this visit. Set it
to **0** to receive without relaying. Higher limits use more upload bandwidth;
available values follow the device's capability. Older sites offer only
**Raise relay limit**.

In P2P-only rooms with a limit of **1**, keep the first Viewer's relay limit
above zero so others can connect through them. If that Viewer disables relaying,
raise the room limit or their personal limit to make another path available.

## Picture and sound settings

1. Below the picture, open **Sharing settings → Picture**.
2. Choose a preset. Use **Fine-tune picture** only when you need a specific
   resolution, frame rate, bitrate, picture preference or codec.
3. Open **Sound** to choose the source audio and its output quality.

![Sharing settings on the Picture tab, with presets above the collapsed fine-tuning controls.](../assets/guide/sharing-settings.en.png#gh-light-mode-only)
![Sharing settings on the Picture tab, with presets above the collapsed fine-tuning controls.](../assets/guide/sharing-settings.en.dark.png#gh-dark-mode-only)

| Setting | What to expect |
| --- | --- |
| Resolution | A ceiling. Portrait and ultrawide sources keep their proportions. |
| Slider or custom value | Sliders cover common values. Type within the field's allowed range for other values; **Use common range** returns to a nearby slider value. |
| Picture and sound quality | Both still adapt to the source, device and available bandwidth. |

If the picture stays blurry or slow for several viewers, try a lower resolution
or frame rate and check the Host preview. If the Host's preview runs smoothly but your picture pauses briefly, open **Playback settings** on the picture and turn on **Increase playback buffering** if available. It adds delay, so turn it off if controls feel sluggish.
See [picture troubleshooting](./troubleshooting.md#the-picture-is-blurry-or-keeps-freezing) for more checks.

Applied settings are remembered for the current site. Opening Piik through an
updated App also keeps sharing-quality settings when a public-invite address changes.

### Include your microphone

Under **Sharing settings → Sound**, enable **Include my microphone** to add your
voice to the shared picture. It starts off for each new share and stops with
sharing. Viewers hear it through the picture's sound without joining room voice.
Room voice remains independent. If you enable both microphones, listeners may
hear you twice; Piik warns you and leaves the choice to you.

## iPhone and iPad screen sharing

Use **Safari on iOS/iPadOS 27 or later** and select **Browser** to share your screen.
Watching a friend and camera sharing use the browser's existing capabilities
and do not require this screen-sharing version.

Safari screen sharing does **not** capture system audio. To speak with the picture,
explicitly enable [Include my microphone](#include-your-microphone).
MDN's [verified Safari 27 support](https://github.com/mdn/browser-compat-data/pull/30732)
and [screen/audio compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json)
distinguish screen capture from audio capture.

## Cameras and virtual audio inputs

![Source audio and share microphone follow the picture and playback volume. Room voice uses its separate listening volume.](../assets/guide/audio-paths.en.svg)

In **Camera**, allow video access and select a picture card. While sharing one
camera, the others are listed by name. Select a camera's built-in microphone
separately for source commentary or room voice. For OBS Virtual Camera audio, follow
the [OBS audio-routing guide](https://obsproject.com/kb/video-call-streaming-tutorial/),
then choose that input for source commentary under **Sharing settings → Sound**,
or use [room voice’s microphone settings](./room-tools.md#room-voice) for the separate conversation channel.

## Exclude a voice app from screen audio

On Windows, this control applies to system sound from **Screens**. **Apps / Windows**
captures only the selected application's process tree. **Camera** shares video;
its microphone or virtual audio input requires explicitly enabled source commentary or room voice.

If Piik and the content you want to share are in different tabs of the same browser, choose the browser source, select the content tab, and enable tab audio. You can hear the room while sharing that tab’s sound. Excluding the browser process in Windows can also remove the other tabs’ sound.

1. Open **Screens** and enable **System sound**.
2. Under **Exclude application audio**, select the voice app's window. Open its
   window and refresh the list if missing.
3. Select the screen to share.

This excludes that process and its children from system sound. Other apps,
including separate mixers and apps using other playback devices, remain audible.
For a single application's sound, share it through **Apps / Windows** instead.
Use headphones to prevent speaker sound entering your microphone.

If your virtual microphone is audible while muted in Piik, temporarily turn off
**System sound**. If that removes the voice, check your mixer's playback output
and monitoring, or share only the desired application's audio.

While sharing, use **Sharing settings → Sound** to change system sound or the
excluded app without stopping the share. If the app closes or restarts, source
audio stops; refresh the application list and select it again.
Turning source audio off retains the exclusion choice;
select **None** to restore unfiltered system audio.
The option appears when the connected Windows App and system support exclusion.
If the option is absent, share a single application window or route the voice
app to a different playback device.
