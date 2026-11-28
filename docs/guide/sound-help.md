# Missing game sound, quiet microphones and echo

English · [简体中文](./sound-help.zh-CN.md)

[Game sound](#i-can-see-the-picture-but-cannot-hear-the-game) · [I can’t hear a friend](#i-cannot-hear-a-friend-speaking) · [Friends can’t hear me](#my-friends-cannot-hear-me) · [Echo](#i-hear-my-own-voice-twice)

## I can see the picture but cannot hear the game

1. Ask the host to play a game sound they can hear. Tap the picture, select **Unmute** if the player is muted, and turn up the volume. If other viewers can hear the game, check your headphones or speakers.
2. If nobody hears the game, ask the Host to pick what to share again and enable sound. Safari screen sharing on iPhone and iPad sends the picture only. The Host can still turn on **Include my microphone**. For a camera or OBS Virtual Camera, enable **Include my microphone** under **Sharing settings → Sound** and select the input carrying the sound. [Set up a camera or virtual audio input](./sharing.md#cameras-and-virtual-audio-inputs)
3. When the Windows App shares the entire screen without excluding any apps, ask the Host to check the default output device in Windows sound settings and make sure the game uses it. The Host can also share just the game window and ask a Viewer to listen again.

![When the Host selects a game window in the Windows App, Application sound appears above the window preview.](../assets/guide/share-source-confirm.en.png#gh-light-mode-only)
![When the Host selects a game window in the Windows App, Application sound appears above the window preview.](../assets/guide/share-source-confirm.en.dark.png#gh-dark-mode-only)

## I cannot hear a friend speaking

Ask how your friend is speaking. If the Host enabled **Include my microphone**, their voice plays with the picture. The Host can check **Sharing settings → Sound**, and Viewers can unmute the video.

For room voice, the Host selects **Open room voice** and both people open **Interact → Voice** and select **Join voice**. Ask the speaker to turn on their microphone. If others hear them, check whether you paused listening or muted that person. [Room voice controls](./room-tools.md#room-voice)

## My friends cannot hear me

1. Open **Interact → Voice → Voice settings**, choose the microphone you are using and check input volume. Allow microphone access in the browser and ask a friend to listen. **Pause listening** only pauses what you hear.
2. If the browser cannot enable the microphone, reopen the full HTTPS invitation from the Host. If the invitation is for a local room and your browser shows a certificate warning, confirm the certificate with the Host. If the browser cannot accept the local certificate, ask the Host for an HTTPS invitation your browser trusts. [Confirm the local certificate](./troubleshooting.md#local-https-certificate-warning)
3. If both people see **Voice connection issue**, open the same invitation in another browser. With a public invitation, you can also try a phone hotspot. [Check the voice connection](./network.md)

## I hear my own voice twice

1. Keep room voice on, turn only that stream’s playback volume to zero and speak. If the echo stops, restore the volume and ask the Host to temporarily turn off source audio. For a full-screen share, that setting is **System sound**.
2. If the echo stops again and the Host still hears you, the share is picking up the call. In a desktop browser, share only the game or video tab with tab audio and keep Piik in another tab. Separate browser processes are unnecessary. Piik App on Windows can share the game window or exclude the app playing the call during full-screen sharing. [Exclude a voice app from screen audio](./sharing.md#exclude-a-voice-app-from-screen-audio)
3. If the echo continues with stream playback muted, ask anyone using speakers to try headphones. If muting source audio leaves an echo, also try turning off the Host’s **Include my microphone**.

On a phone, first turn off **Include my microphone** and keep room voice on, so the microphone is not sent through both the stream and the call. If source audio is available and turning it off removes the echo, share only the picture; use another device for the call when you also need content sound. Headphones can reduce speaker sound picked up by a microphone, but cannot prevent system recording from capturing the call directly.

<details>
<summary>Check monitoring outputs when using a virtual mixer</summary>

Temporarily turn off **System sound**. If the duplicate disappears, check which mixer output feeds the default playback device. Adjust monitoring, restore system sound and ask your friend to listen again.

</details>
