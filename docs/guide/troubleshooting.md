---
outline: 2
---

# Troubleshooting

This guide covers the 3.0 internal test. For published 2.x, use the [2.6.1 troubleshooting guide](https://github.com/TNTcraftHIM/Piik/blob/v2.6.1/docs/guide/troubleshooting.md).

English · [简体中文](./troubleshooting.zh-CN.md) · [Documentation](./README.md)

Find your symptom below. Try its checks in order and stop when it works.
If it persists, [save a diagnostic report](#reporting-a-problem) before refreshing.

## Common problems

Start at the first thing that fails:

| What you see | Check first |
| --- | --- |
| App does not open, or invitation will not load | [App and room entry](#opening-app-and-joining-a-room). |
| Chat or history does not load | [Domain connection and room hosting](#chat-or-history-will-not-load). |
| An attachment is visible but cannot be opened or downloaded | [File availability and delivery](#an-attachment-will-not-open-or-download). |
| Source picker is missing or sharing will not start | [Source and capture checks](#starting-a-share). |
| Page opens, but the picture will not connect | [Media connection](#when-video-will-not-connect). |
| Picture blurs or stutters | [Picture quality](#picture-blurs-stutters-or-stops). |
| Phone fullscreen or playback controls are missing | [Fullscreen and controls](#fullscreen-or-playback-after-sleep). |
| Picture works, but no game/movie sound | [Source sound](#picture-but-no-source-sound). |
| Cannot hear a friend, or cannot use the microphone | [Room voice](#cannot-hear-someone-speaking) and [permissions](#microphone-or-remote-controls-are-unavailable). |
| Gamepad does not respond | [Gamepad checks](#gamepads). |

Leave [advanced network checks](./network.md) until the matching
symptom's simple checks have failed. Change one thing at a time.

## Opening App and joining a room

[Startup](#app-startup-fails-or-no-page-opens) · [Android installation](#android-apk-will-not-install) · [macOS](#macos-blocks-first-launch) ·
[Public invite / 1033](#public-invitation-fails-or-shows-1033) · [Local invitation](#local-invitation-will-not-open) ·
[Local certificate](#local-https-certificate-warning) · [Invitation or password](#an-invitation-or-password-is-rejected) · [Domain connection](#the-page-opens-but-the-domain-will-not-connect)

### App startup fails, or no page opens

1. Read the reason on the launch page and in the terminal. If the App is still
   running, copy its displayed address into your browser.
2. If Local mode lists several addresses, choose the adapter and IP that friends
   can reach. See [Local invitation checks](#local-invitation-will-not-open).
3. If startup still fails, enable **Help → Debug** on the App launcher, retry and save the complete
   error and an [App report](#reporting-a-problem).

### Android APK will not install

Use the 3.0 test APK supplied with your invitation; the [App guide](./getting-started.md#share-with-piik-app) covers installation.
If Android asks, allow this browser or file manager to install the downloaded APK.

If Android reports a signature or package conflict, check that the APK belongs
to the same test channel as the installed App. Do not uninstall or clear App
data just to retry: that can remove hosted rooms and history. Keep a
[backup](../../prototype/channel-server/README.md#saved-data-and-files) before
switching channels. Browser identity and settings are stored separately.

### macOS blocks first launch

Current Mac builds are not Developer ID-signed or notarized by Apple. For
first-launch warnings, verify the download and allow this App through macOS:

If macOS reports malware, says the App will damage your computer, or moves it
to Trash automatically, [report the exact alert and download link](#reporting-a-problem).
Do not use the quarantine command below for those alerts.

1. Use a Mac build supplied for your testing channel and compare its
   SHA-256 with the checksum supplied for that build. In Terminal, run
   `shasum -a256 ~/Downloads/piik-app-darwin-arm64.zip` (use `darwin-amd64` on Intel).
   If it differs, download again rather than bypassing the warning.
2. Move the complete `Piik App.app` to Applications. Try opening it, then check
   **System Settings → Privacy & Security → Open Anyway**, as described in
   [Apple's first-launch guidance](https://support.apple.com/102445).
3. If **Open Anyway** is unavailable and the supplied ZIP's checksum matches,
   you can remove the download quarantine from this App only, then reopen it:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Piik App.app"
   ```

Use the App's actual path if you kept it elsewhere. Keep system-wide security
checks enabled.

### Public invitation fails or shows 1033

App **Public invite** uses Cloudflare Tunnel for its temporary web address.
[Error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/)
means the tunnel is disconnected. For `public invitation service exited before
connecting` or `exit status 1`, read the following error details to choose a check.

1. **Viewers: confirm the link.** Ask the host to check that the App is running
   and the computer is awake, then send the current invitation. Use a new link
   after the App restarts; the old address may no longer work.
2. **Hosts: read the failure details.** Check that the complete App package was
   extracted. Save the full error from the launch page or terminal, including
   any detail after the exit code, then enable **Help → Debug** on the launcher and try again.
3. **Compare networks.** Try a phone hotspot. Check whether DNS, a proxy or a
   firewall blocks Cloudflare Tunnel; adjust only relevant rules. Ask the
   administrator about a school or workplace network.

<details>
<summary>Advanced: tunnel errors, proxy routing and port 7844</summary>

If you use a proxy, confirm that it actually routes the `cloudflared` process.
Browser proxy settings or `HTTP_PROXY`/`HTTPS_PROXY` alone do not route the
currently bundled tunnel helper through a proxy.

The error details help identify which stage failed:

| Error contains | What to check |
| --- | --- |
| `failed to request quick Tunnel` or `api.trycloudflare.com` | The temporary address could not be allocated. Read the cause that follows: check DNS for lookup errors, or outbound HTTPS, proxy rules and service status for connection timeouts. |
| QUIC timeout, `dial tcp ...:7844` or `TLS handshake with edge` | The connection to a Cloudflare tunnel endpoint failed. Check outbound rules for `cloudflared`, including whether a proxy or game accelerator affects the connection. |

Piik tries HTTP/2 (TCP) when QUIC (UDP) fails. Allow outbound port `7844` for both.
See [Cloudflare's connection troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/)
for the requirements. You do not need to open an inbound port on your router.

</details>

If the temporary address is unavailable, you can use an existing **3.0** domain.
To switch this App to [Local network](./network.md#optional-a-virtual-lan), finish
its current shares, quit normally and reopen App, then select that mode.
The public Demo and published 2.x
sites are separate versions. If a permanent domain is unavailable, ask its
operator to check the service. Once the page opens, distinguish
[chat/hosting problems](#chat-or-history-will-not-load) from [peer connection problems](#when-video-will-not-connect).

### Local invitation will not open

If the browser times out before showing Piik, check access to the Host's App:

1. Keep the host's App running. In **Local network**, select an adapter address
   friends can reach and send the full invitation link. Both devices need a
   reachable LAN or the same virtual LAN; guest Wi-Fi may isolate them.
2. On the Windows host, open **Windows Security → Firewall & network protection →
   Allow an app through firewall**. Check the currently running `piik-app.exe`
   and allow the network type in use. A virtual adapter may be classified as
   **Public**; advanced rules can restrict access to that adapter and subnet.
3. After extracting an update to another folder, update any firewall rule that
   points to the old file. Add the current App manually if needed; keep the firewall on.

If App reports that a local port is unavailable, close the older App instance
using it. For a deliberately configured port, use the current
[App runtime settings](../../prototype/channel-server/README.md#local-app-link),
then send the newly generated invitation; editing only its URL does not move the service.

Changing permissions may require an administrator; see
[Microsoft's instructions](https://support.microsoft.com/en-us/windows/security/firewall/risks-of-allowing-apps-through-windows-firewall).
If the page opens but video does not connect, continue with
[media connection checks](#when-video-will-not-connect).

### Local HTTPS certificate warning

Piik App's Local network invitation uses a temporary self-signed HTTPS
certificate. The browser can show a certificate warning before opening it.

1. Check that the address is the one the Host intended to share.
2. Ask the App owner to start **Local network**, return to the App launcher and
   expand **Local connection details** below **Open Piik**. It shows the actual
   HTTPS address and certificate **SHA-256 fingerprint**; **Copy verification
   details** copies both. The App terminal's **Certificate SHA-256** is an
   alternative on desktop.
3. Open the warning's certificate details and compare its **SHA-256 fingerprint**
   with that value. If you are on another device, confirm it with the App owner
   over your usual trusted chat.
4. If it matches, use the browser's **Advanced → Continue** option where available.
   Then allow microphone access or request remote control normally.

The temporary certificate changes after an App restart. A different
fingerprint needs confirmation again; the App saves no certificate files and
does not install a trusted CA. Do not disable browser security checks globally.
If the browser cannot accept an exception, use a site with a certificate that
device already trusts; operators can use the [3.0 runtime reference](../../prototype/channel-server/README.md#run).

These instructions apply to an expected local self-signed certificate. An
unexpected warning on a public HTTPS site needs investigation by its operator.

### An invitation or password is rejected

Open the full current 3.0 link, including its invitation part. Domain and room
invitations are different. A private domain can require its invitation or
passphrase; a private room can require a separate invitation or room password.
Ask the respective owner for the current link after a reset. Use the same
browser profile to retain your existing identity; private/incognito profiles
have separate saved credentials.

If Piik asks you to update, use matching 3.0 App, Web and Server versions, then
reload. A 2.x App or domain is not a replacement for the test endpoint.

### The page opens but the domain will not connect

Read the status at the top of the page. If it remains disconnected, compare the
same link in another browser or network and read the visible error.

#### Room creation returns 403

If domain access or room creation is rejected with HTTP 403, operators should
check that the frontend and WebSocket reach the same domain service and
that the browser's exact origin is allowed; see the [runtime setup](../../prototype/channel-server/README.md#run).
A proxy/WAF HTTP error needs that operator's logs. Do not disable origin checks.

## Chat and files

### Chat or history will not load

1. Check the domain connection at the top. Use **Reconnect** when it is disconnected.
2. Read the room notice. **This room is unavailable** means its host needs to return: keep the hosting Browser page open, or restart the App that hosts it. Opening your own App does not take over someone else's room.
3. If the room is online, use **Load messages** after a failed read and keep the complete error. A storage error belongs to the room host; collect its report too.

Chat, history, message reactions and attachment descriptions travel through
the domain connection. They do not need media UDP. If chat works but picture,
voice or file transfer fails, check that activity below.

### An attachment will not open or download

1. Keep the sending page, or another participant holding a readable copy, online. A saved attachment card alone does not provide its file content.
2. Try **Download** or **View image**. Use **Cancel download** to stop a pending transfer, then retry when the source or connection is available.
3. If messages arrive but downloads do not, check [peer connectivity](./network.md). File content use P2P even though their descriptions arrived through chat.
4. If the browser reports a failed save, check its download list, free space and chosen folder permissions. Include the exact browser error in your report.

A failed or canceled file transfer does not end room chat. Do not clear site
storage to retry; that can remove retained files, identity or a Browser-hosted room.

## Starting a share

[No picker](#no-screen-picker) · [Missing windows](#app-windows-or-screens-are-missing) ·
[Source selected, sharing fails](#sharing-does-not-start-after-source-selection) · [H264 failure](#h264-sharing-fails-on-windows)

When sharing fails, read the error notice at the top of the page. Keep its
wording and the selected source type before retrying. Current report steps are
under [Reporting a problem](#reporting-a-problem).

### No screen picker

Allow screen recording when your OS asks. Browser screen capture needs HTTPS or
`localhost`; try sharing from a desktop computer. In the source picker, choose
**Browser → Choose what to share** to open the browser's screen, window or tab
chooser. Missing App sources are covered below.

### App windows or screens are missing

Keep App running on the sharing computer. Select **App** at the top of the site,
confirm the site on the local approval page, and allow browser local-network
access if asked. Refresh the list; review this site's permissions if previously blocked.

The source picker distinguishes these outcomes:

| Message | Next step |
| --- | --- |
| Cannot connect to Piik App | Confirm the App is running and this site is approved. Close idle pages using the App if it reports a busy request, then retry. |
| Piik App and this page are incompatible | Update Piik App and reload the page. |
| Piik App capture is currently unavailable | Check the App diagnostics for capture or encoder availability. Review your encoding setting or use browser capture. |
| Could not read the screen and window list | Refresh to retry. If it keeps failing, collect both the App and browser reports. |
| No sources available | The list was read successfully, but this tab has no selectable sources. Check the other source tabs. |

Local-network permission lets the page contact App. For media failures after
connection, check [WebRTC settings](./network.md#browser-webrtc-restrictions).

### Sharing does not start after source selection

Read the page's error notice, then compare the affected source:

- **App disconnected or request timed out:** keep App running and connect it with **App** in the page header. Allow local-network access when asked.
- **App could not start the source:** try an ordinary window or screen, then the **Browser** picker. Select Auto or VP8 before sharing if the H264 path fails.
- **Device permission was declined:** allow the relevant OS/browser screen or camera permission, keep the source open and select it again. Check whether another app holds the camera.
- **Picture starts but cannot reach a viewer:** use [picture connection checks](#when-video-will-not-connect).

If it still fails, [collect reports](#reporting-a-problem) from the same attempt.

### H264 sharing fails on Windows

1. **Compare codecs on the same source.** In **Picture and sound → Picture → Fine-tune picture**, change the
   video codec from **H264** to **Auto** or **VP8**, then start sharing again.
   If VP8 works, you can keep using it while checking the H264 path.
2. **Update and restart.** Update Piik App and Chrome, and install the appropriate
   graphics driver from your computer or GPU manufacturer's official support
   page. On laptops with two GPUs, check both drivers. Restart after installation.
3. **For Chrome, check graphics acceleration and GPU preference.** In Chrome's
   **Settings → System**, enable graphics acceleration if it was disabled, then
   restart Chrome ([Google's setting instructions](https://support.google.com/meet/answer/10058482?hl=en)).
   On a multi-GPU Windows PC, open **Settings → System → Display → Graphics**,
   select or add Chrome (`chrome.exe`), and choose **Options → High performance → Save**.
   Completely quit and reopen Chrome before retrying. If it does not help, restore
   **Let Windows decide** ([Microsoft's graphics settings](https://support.microsoft.com/en-us/windows/hardware/display-graphics/optimizations-for-windowed-games-in-windows-11)).

Chrome's graphics preference applies to browser capture. Piik App selects its
native encoder separately. If it still fails, [save reports](#reporting-a-problem)
with the codec comparison. If both codecs fail, also check
[WebRTC restrictions](./network.md#browser-webrtc-restrictions).

## Picture and playback

[No connection](#when-video-will-not-connect) · [Blur / stutter](#picture-blurs-stutters-or-stops) ·
[Black game capture](#game-capture-is-black-or-sharing-stops) · [Washed-out HDR](#hdr-picture-looks-too-bright-or-washed-out) ·
[Capture border](#yellow-capture-border-on-windows) · [Fullscreen / sleep](#fullscreen-or-playback-after-sleep)

### When video will not connect

Check the particular share rather than treating all room traffic as one connection:

1. Confirm that its owner is still sharing and has not paused it. Select **Watch** on that source; automatic retry is shown in its picture tile.
2. Compare [browser WebRTC settings](./network.md#browser-webrtc-restrictions), especially if chat works.
3. Try another network such as a hotspot. Review the VPN/proxy's UDP policy; ask an administrator on a managed network.

Use [advanced network checks](./network.md) if these checks do not help. Record
whether the same room's chat and other pictures still work.

### Picture blurs, stutters or stops

Brief blur can result from automatic adjustments to network or encoding load.
If it recurs or never recovers, compare the following:

1. **Identify who is affected.** Is it the sharer's preview, every viewer or just
   one viewer? Note the time and whether it recovers on its own.
2. **Change one thing at a time.** The sharer can try a lower resolution or frame
   rate under **Picture and sound → Picture**, and check CPU/GPU load while the game runs.
   An affected viewer can compare another browser or a phone hotspot. Increasing
   bitrate does not necessarily help.
3. **Compare capture paths.** Stop this share, then try Auto or VP8 before starting again. Compare App window/screen capture with Browser capture on the same source. Software encoding can compete with a game for CPU; App hardware encoding and Browser settings are separate.
4. **Save evidence while it happens.** Collect the sharer's and affected watcher's [reports](#reporting-a-problem), including an App report for App capture. Note whether the picture recovers before retrying.

If sharing stopped altogether, read the page's error notice and follow
[sharing startup checks](#sharing-does-not-start-after-source-selection). If the
sharer is still sharing but viewers cannot receive video, follow [connection checks](#when-video-will-not-connect).

### Game capture is black or sharing stops

Check that you selected the game's window or the screen displaying it, then try
the game's borderless window mode. Compare an ordinary window, and try both App
capture and the **Browser** source picker. Protected content may be unavailable
for capture.

If Piik stops that share after you enter a game, read the page's error notice and follow [sharing startup checks](#sharing-does-not-start-after-source-selection).
Include the game and window mode in your [report](#reporting-a-problem).

### HDR picture looks too bright or washed out

Windows App capture through **Apps / Windows** or **Screens** converts HDR to SDR
for viewers. The **Browser** picker uses browser capture instead; some HDR sources
can look overexposed. Try the App categories above,
or temporarily turn off HDR in Windows display settings and select the source again.
Higher resolution or bitrate cannot restore clipped highlights.

If it persists, report the HDR setting and GPU/display model with source/viewer
comparison pictures. See [HDR capture notes](../research/media-fidelity.md#hdr-to-sdr) for background.

### Yellow capture border on Windows

Windows draws this outline to identify the window or display being captured.
When the App's capture runtime supports it, the source picker offers **Show capture border**,
off by default. Windows permissions or another active capture can still require
the border. Windows 10 does not provide this control for its capture API.

#### Windows 11: the border is still visible

1. Select **Apps / Windows** or **Screens** in Piik and leave **Show capture border**
   off. A Browser-selected source uses the browser's own capture indicator.
2. Stop other apps or tabs capturing the same window/display, then restart sharing.
3. If Windows denied borderless capture, review **Screenshot borders** in Windows
   privacy settings. Its settings page can also be opened with
   `ms-settings:privacy-graphicscapturewithoutborder` from **Win+R**, when available.

Windows requires consent and can retain the border when another capture requests
it ([Microsoft's API documentation](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)).
If it persists, include the Windows version and an [App report](#reporting-a-problem).

<details>
<summary>Advanced: optional Windows 10 workaround</summary>

#### Optional Windows 10 workaround

[DWM Custom Projection Border](https://windhawk.net/mods/dwm-custom-projection-border)
is a third-party Windhawk mod for x64 Windows that can hide the border while keeping the same
capture method. It changes Windows' desktop compositor and affects other apps'
capture indicators too. Follow the mod's Windows version requirements.

1. Install [Windhawk](https://windhawk.net/) from its official website.
2. In Windhawk's global **Settings → Advanced settings → More advanced settings**,
   append `dwm.exe` to **Process inclusion list** and save. Keep existing entries.
3. Find and install **DWM Custom Projection Border**. In the mod's settings,
   turn on **Disable border** and save.
4. Stop and restart sharing in Piik, then check whether the border disappears.

To undo this, disable the mod and restart sharing. Remove the `dwm.exe` entry
if you added it only for this mod. If desktop problems appear or a Windows
update breaks compatibility, disable the mod first.

See the [mod author's instructions](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/dwm-custom-projection-border.wh.cpp)
and [Windhawk's process settings](https://github.com/ramensoftware/windhawk/wiki/Injection-targets-and-critical-system-processes)
for current setup details.

</details>

### Fullscreen or playback after sleep

- **Playback controls are hidden:** tap the picture to bring them back. Use the controls on the affected picture, not another share's tile.
- **Fullscreen is missing or rejected:** open the invitation in a standalone
  browser, such as Chrome on Android or Safari on iPhone, instead of a chat app's
  embedded browser. **Theater mode** expands playback within the page when the
  browser does not offer screen fullscreen.
- **Piik controls disappear in fullscreen:** the browser has opened its native
  video player. Exit fullscreen and use **Theater mode** to keep Piik's playback
  controls, chat overlay and remote input on the page.
- **Phone fullscreen has black bars:** video preserves its proportions. Try
  landscape, or use **Switch picture fit** on the playback bar to select **Fill**
  or **Stretch**. Exit the browser's native video player to use Piik's picture-fit
  controls. See [viewing controls](./getting-started.md#join-a-friends-room).
- **Sharing stops after sleep or suspension:** wake the device and return to the
  sharing tab. Start sharing again if needed; browser and OS suspension can
  interrupt capture or playback.

## Sound and browser permissions

[Source sound](#picture-but-no-source-sound) · [Room voice](#cannot-hear-someone-speaking) ·
[Echo / unwanted sound](#echo-or-unwanted-application-audio) · [Microphone / control permissions](#microphone-or-remote-controls-are-unavailable)

### Picture but no source sound

1. Unmute the video and check your playback volume.
2. The sharer should select a source with shareable audio and enable its sound in
   the source picker. Available sound depends on the source and platform.
3. Camera video and microphone inputs are selected separately. For a built-in
   camera microphone or OBS audio, see [camera and audio inputs](./sharing.md#cameras-and-virtual-audio-inputs).

With a virtual mixer or several output devices, check where the app sends its
sound. Without application exclusion, Windows App screen capture reads the
default playback device. Select the app's window to capture its process audio,
or route its sound to that default
device before restarting screen sharing.

### Cannot hear someone speaking

For speech added through **Include my microphone**, check the picture's
[source sound](#picture-but-no-source-sound) and the sharer's **Picture and sound → Sound**.
For room voice, follow these steps:

1. Both people use **Join voice** in the same room. Its arrow offers **Listen without a microphone**; the main action requests microphone access. Check that the voice-room selector is controlling the intended room.
2. The speaker checks browser microphone permission, input device and input volume
   in **Voice settings**. Microphone access needs HTTPS or `localhost`.
3. Check whether you paused listening or muted that person locally. These controls
   are separate from video mute; **Pause listening** leaves your microphone on.

If voice reports a connection failure, compare [WebRTC settings](./network.md#browser-webrtc-restrictions)
and another network. See [room voice](./room-tools.md#room-voice) for its controls.

### Echo or unwanted application audio

Use headphones if speakers are feeding sound back into a microphone. Windows
App screen capture can [exclude a voice app from source audio](./sharing.md#exclude-a-voice-app-from-screen-audio);
this does not remove acoustic echo.

If a virtual microphone remains audible when muted in Piik, temporarily turn off
**System sound**. If that removes it, the mixer's playback output is also entering
source audio. Check its playback/monitoring route or share only the desired app's
window audio. Piik's microphone mute does not mute that separate source.

### Microphone or remote controls are unavailable

1. Open the complete HTTPS invitation generated by the current App. For a local
   invitation, [confirm its certificate](#local-https-certificate-warning) first.
   A plain HTTP LAN page can play video, chat and listen to voice, but cannot use
   the secure microphone/camera capture or remote-control APIs. Changing only the
   URL scheme does not enable HTTPS; `localhost` means the current device.
2. For a microphone, review this site's browser permission and selected input.
3. For remote control, update the sharer's App and the site, then refresh the watching
   page. The sharer must use desktop App window/screen capture and enable control;
   Browser and camera capture cannot receive remote input. Android can share its
   screen and control a desktop as a watcher, but cannot receive remote control;
   its sharing page therefore has no enable-control action. Follow the
   [authorization steps](./room-tools.md#let-a-friend-control-your-shared-screen).

If your browser cannot accept the local certificate, use a reachable **Public
invite** or an HTTPS site with a trusted certificate.

## Gamepads

### The gamepad does not respond

1. The sharer shares an App window or screen and enables **Remote control**.
2. Check the sharer against [supported platforms and gamepad setup](./remote-control.md#gamepads).
   The sharer installs external drivers from the official source; Piik includes no
   input SDK or driver. Turn Remote control off and on after installation.
3. The Viewer connects a standard-layout controller and presses a button so the
   browser detects it, then obtains remote control. Piik automatically uses the
   first connected controller with the browser's standard mapping. Keep the viewing
   page focused and join the corresponding player in the game. If all controller
   slots are occupied, disconnect an unused controller or end that watcher's remote control.

Watchers only need their browser. Driver checks and installation belong on the sharer.

## Advanced network checks

For pictures, voice or file content that cannot connect after the basic checks,
use the [network guide](./network.md). It groups browser restrictions, network
comparisons, virtual-LAN solutions and router checks. Chat/history problems
start with [domain connection and hosting](#chat-or-history-will-not-load).

## Reporting a problem

Include the Piik version, OS/browser, time, expected result and reproduction steps.
For capture problems, add the source type, codec, GPU/driver and whether another
source or VP8 works. For network problems, add the network type.

- **Web:** open **Help** in the header and enable **Debug**. This reloads the page and interrupts current activities. Reproduce once, then return to **Help → Web report** before another refresh.
- **App capture, hosting or remote control:** enable **Help → Debug** on the local App launcher before reproducing. Return there and select **Help → App report**. On narrow screens, use **More options** to find these controls.
- **Room or connection failure:** include the room host's report and the affected participant's report from the same attempt. For Server-hosted rooms, ask its operator for the corresponding service error.

Reports stay on your device. Review private information before sharing them;
[App diagnostics](../../prototype/channel-server/README.md#app-diagnostics)
explains the report boundary. If reports are unavailable, send the complete
visible error and reproduction steps.

For other guides, return to [the documentation home](./README.md).
