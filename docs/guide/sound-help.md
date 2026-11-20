# Missing game sound, quiet microphones and echo

English · [简体中文](./sound-help.zh-CN.md)

## I can see the picture but cannot hear the game

1. Ask the Host to play game audio they can hear. As a Viewer, tap the picture to reveal the playback controls, select **Unmute**, and turn up playback volume. If another Viewer hears the game, check your headphones and device volume.
2. If nobody hears the game, ask the Host to pick what to share again and enable sound. Safari screen sharing on iPhone does not include game audio. With a camera, including OBS Virtual Camera, the Host selects an audio input separately. [Sharing sources and sound settings](./sharing.md)
3. When the Windows App shares the entire screen without excluding any apps, ask the Host to check the default output device in Windows sound settings and make sure the game uses it. The Host can also share just the game window and ask a Viewer to listen again.

![In the Windows App source picker, Application sound sits above the selected window.](../assets/guide/share-source-confirm.en.png#gh-light-mode-only)
![In the Windows App source picker, Application sound sits above the selected window.](../assets/guide/share-source-confirm.en.dark.png#gh-dark-mode-only)

## I cannot hear a friend speaking

Ask how your friend is speaking. If the Host enabled **Include my microphone**, their voice plays with the picture. The Host can check **Sharing settings → Sound**, and Viewers can unmute the video.

For room voice, the Host selects **Open room voice** and both people open **Interact → Voice** and select **Join voice**. Ask the speaker to turn on their microphone. If others hear them, check whether you paused listening or muted that person. [Room voice controls](./room-tools.md#room-voice)

## My friends cannot hear me

1. Open **Interact → Voice → Voice settings**, choose the microphone you are using and check input volume. Allow microphone access in the browser and ask a friend to listen. **Pause listening** only pauses what you hear.
2. If the browser cannot enable the microphone, reopen the full HTTPS invitation from the Host. If the invitation is for a local room and your browser shows a certificate warning, confirm the certificate with the Host. If the browser cannot accept the local certificate, ask the Host for an HTTPS invitation your browser trusts. [Confirm the local certificate](./troubleshooting.md#local-https-certificate-warning)
3. If both people see **Voice connection issue**, open the same invitation in another browser. If voice still fails, try again on a phone hotspot. [Check the voice connection](./network.md)

## I hear my own voice twice

1. Keep room voice on, turn the stream’s playback volume to zero and speak. If the echo stops, restore the volume and ask the Host to temporarily turn off source audio. For a full-screen share, that setting is **System sound**.
2. If the echo stops again and the Host still hears you, the share is picking up the call. The Host can share the game window or exclude the app playing the call during full-screen sharing. If the game and call use the same browser, share the game tab with tab audio. [Exclude a voice app from screen audio](./sharing.md#exclude-a-voice-app-from-screen-audio)
3. If the echo continues with stream playback muted, ask anyone using speakers to try headphones. If muting source audio leaves an echo, also try turning off the Host’s **Include my microphone**.

<details>
<summary>Check monitoring outputs when using a virtual mixer</summary>

Temporarily turn off **System sound**. If the duplicate disappears, check which mixer output feeds the default playback device. Adjust monitoring, restore system sound and ask your friend to listen again.

</details>
