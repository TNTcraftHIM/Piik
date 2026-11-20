---
outline: 2
---

# Troubleshooting

English · [简体中文](./troubleshooting.zh-CN.md) · [Documentation](./README.md)

Find your symptom below. Try its checks in order and stop when it works.
If it persists, [save a diagnostic report](#reporting-a-problem) before refreshing.

## Common problems

Start at the first thing that fails:

| What you see | Check first |
| --- | --- |
| Invitation never opens, or only the page title appears | [Check the invitation](#i-cannot-join-my-friends-room). |
| You entered the room but the TV has no picture | [Check the sharing connection](#when-video-will-not-connect). |
| App is not ready | Start App on the sharing device and [authorize the current site](./getting-started.md#use-app-with-an-existing-site). |
| iPhone Safari shares the screen but friends hear no game audio | Safari screen sharing excludes system audio. See [iPhone and iPad screen sharing](./sharing.md#iphone-and-ipad-screen-sharing). |
| Source picker is missing or sharing will not start | [Source and capture checks](#starting-a-share). |
| Picture blurs or stutters | [Picture quality](#the-picture-is-blurry-or-keeps-freezing). |
| Phone fullscreen or playback controls are missing | [Fullscreen and controls](#fullscreen-or-playback-after-sleep). |
| Picture works, but no game/movie sound | [Source sound](#picture-but-no-source-sound). |
| Cannot hear a friend, or cannot use the microphone | [Room voice](#cannot-hear-someone-speaking) and [permissions](#microphone-or-remote-controls-are-unavailable). |
| Gamepad does not respond | [Gamepad checks](#gamepads). |

Leave [advanced network checks](./network.md) until the matching
symptom's simple checks have failed. Change one thing at a time.


## Opening App and joining a room

[Startup](#app-startup-fails-or-no-page-opens) · [Android installation](#android-apk-will-not-install) · [macOS](#macos-blocks-first-launch) ·
[Public invite / 1033](#public-invitation-fails-or-shows-1033) · [Local invitation](#local-invitation-will-not-open) ·
[Local certificate](#local-https-certificate-warning) · [Room code](#room-code-does-not-work) · [Room creation 403](#room-creation-returns-403)

<span id="invite-blank"></span>

<a id="the-invitation-opens-to-a-blank-page"></a>

### I cannot join my friend’s room

Ask the Host to send the current invitation and open the full link in your browser. If only your browser shows a blank page, try the same link in another browser. If friends also cannot reach it, check the type of invitation. A [local invitation](#local-invitation-will-not-open) needs a reachable local network. For a public address or error 1033, ask the Host to [check the public invitation](#public-invitation-fails-or-shows-1033).

<span id="app-not-ready"></span>

### App startup fails, or no page opens

1. Read the reason on the launch page and in the terminal. If the App is still
   running, copy its displayed address into your browser.
2. If Local mode lists several addresses, choose the adapter and IP that friends
   can reach. See [Local invitation checks](#local-invitation-will-not-open).
3. If startup still fails, retry with **Debug launch** enabled and save the complete
   error and an [App report](#reporting-a-problem).

### Android APK will not install

Download the APK from the [App installation steps](./getting-started.md#share-with-piik-app).
If Android asks, allow this browser or file manager to install the downloaded APK.

If installation reports a conflicting package or signature and you previously
installed a test build, uninstall that test App before installing the official
APK. The test build and official release use different signing keys. Uninstalling
clears App settings, including approved sites and the starred startup site;
browser settings are stored separately. Later official updates can be installed
over the existing official App.

### macOS blocks first launch

Current Mac builds are not Developer ID-signed or notarized by Apple. For
first-launch warnings, verify the download and allow this App through macOS:

If macOS reports malware, says the App will damage your computer, or moves it
to Trash automatically, [report the exact alert and download link](#reporting-a-problem).
Do not use the quarantine command below for those alerts.

1. Download the matching Mac ZIP from the project's Releases and compare its
   SHA-256 with the checksum published for that release. In Terminal, run
   `shasum -a256 ~/Downloads/piik-app-darwin-arm64.zip` (use `darwin-amd64` on Intel).
   If it differs, download again rather than bypassing the warning.
2. Move the complete `Piik App.app` to Applications. Try opening it, then check
   **System Settings → Privacy & Security → Open Anyway**, as described in
   [Apple's first-launch guidance](https://support.apple.com/102445).
3. If **Open Anyway** is unavailable and the official ZIP's checksum matches,
   you can remove the download quarantine from this App only, then reopen it:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Piik App.app"
   ```

Use the App's actual path if you kept it elsewhere. Keep system-wide security
checks enabled.

### Public invitation fails or shows 1033

1. Ask the Host to wake the computer, keep App running and send the current invitation. Restarting App can change the temporary address. [Error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/) means the invitation tunnel has disconnected.
2. On the Host, extract the full App package and retry with **Debug launch**. For `exit status 1` or `public invitation service exited before connecting`, save the detail after the exit code.
3. Try a phone hotspot. If it works, ask the network administrator to check DNS, proxy routing and firewall rules using the errors below.

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

**To continue without a public invite:** keep App running, open
[Piik online](https://demo.piik.tv) or another reachable site, and
[authorize App capture](./getting-started.md#use-app-with-an-existing-site).
Send the new site's room invitation. Piik online needs no site passphrase and
uses P2P media; for server media forwarding, choose an SFU-enabled site.
If the page opens but video does not connect, follow
[media connection troubleshooting](#when-video-will-not-connect).
If the unavailable address is a self-hosted site rather than the App's
temporary address, ask that site's administrator to check its service.

### Local invitation will not open

1. Keep the Host’s App running. In **Local room**, select an adapter address the Viewer can reach and send the full invitation. Both devices need a reachable LAN or the same virtual LAN. Guest Wi-Fi may isolate devices.
2. If your friend cannot use the same network, ask the Host for a current **Public invite**.

<details>
<summary>Advanced Host checks · Firewall and ports</summary>

1. On Windows, open **Windows Security → Firewall & network protection → Allow an app through firewall**. Allow the current `piik-app.exe` on the network type in use. Update the rule if you extracted App to a new folder. Virtual adapters may use the **Public** profile. Advanced rules can limit access to the adapter and subnet. [Microsoft firewall instructions](https://support.microsoft.com/en-us/windows/security/firewall/risks-of-allowing-apps-through-windows-firewall)
2. If App reports **the local port is unavailable**, close the older Piik instance using it. If another app needs the port, launch Piik with `--port 9876` and send the new invitation. The web and local STUN ports must both be available.

</details>

Once the page opens, follow the [picture connection checks](#when-video-will-not-connect) if the TV stays empty.

<details>
<summary>Optional · Check page requests and MTU when a virtual LAN invitation only shows the title</summary>

If the tab shows **Piik** but the page stays blank or keeps loading, open the
browser's **Developer Tools → Network** and reload the invitation. Check the
document and the main JavaScript request.

- If a request stays pending or times out, try the same Host on a shared LAN
  if possible. If it works there and stalls on the virtual LAN, check the
  virtual network path, including whether it can deliver larger packets.
- If JavaScript returns `404`, reopen the current invitation in a private
  window. If it persists, tell the Host which build is running and that the
  script returned `404`.
- If JavaScript finishes downloading and the page still stalls, check the
  browser's **Console** for a JavaScript error.

If a small response (such as the page document) arrives while the full script
times out, the tunnel may be dropping larger packets. A fresh connection may
also time out during TLS before the browser receives any HTTP response. To
compare before and after on your virtual LAN:

1. Confirm which virtual adapter carries the invitation on both devices. Record
   its MTU (maximum packet size) and test the same invitation on a fresh connection.
2. Use the provider's supported controls to restore path-MTU feedback (such as
   ICMP Packet Too Big) or set both virtual adapters to an MTU supported by the
   known tunnel path. If the provider manages these settings, ask its support team.
3. Open a fresh connection and check whether both the document and full script
   load. Restore the original settings if the change does not help.

</details>

### Local HTTPS certificate warning

Close the warning and confirm the address with the Host through your usual chat. Ask for a current **Public invite**. If a public address also shows a warning, tell the site administrator and wait for them to fix it.

<details>
<summary>Advanced · Verify an expected local certificate with the Host</summary>

Piik App's **Local room**, and servers using `TLS_SELF_SIGNED=true`, generate a
local certificate without asking a public certificate authority. The browser
therefore shows a certificate warning before opening the invitation.

1. Check that the address is the one the Host intended to share.
2. Open the warning's certificate details and compare its **SHA-256 fingerprint**
   with **Local certificate · SHA-256** in the Host's App terminal, or the
   Server's **HTTPS certificate** startup message. Ask the Host over your usual
   trusted chat if you are on another device.
3. If it matches, use the browser's **Advanced → Continue** option where available.
   Then allow microphone access or request remote control normally.

The temporary certificate changes after an App/Server restart. A different
fingerprint needs confirmation again; the App saves no certificate files and
does not install a trusted CA. Do not disable browser security checks globally.
If the browser cannot accept an exception, use a site with a certificate that
device already trusts; administrators can follow the [HTTPS deployment guide](../operations/self-hosting.md#2-enable-https).

These instructions apply to an expected local self-signed certificate. An
unexpected warning on a public HTTPS site needs investigation by its operator.

</details>

### Room code does not work

Open the Host's current full invitation link first. A room code works only on
its original Piik site. A site with empty-room recycling may have reclaimed the
room; the Host can create a new one. See [joining a room](./getting-started.md#join-a-friends-room).

If all room codes on the site are in use, retry later or use another Piik site.
Administrators can configure [empty-room retention](../operations/self-hosting.md#1-configure-and-start-piik)
to reclaim unused codes.

### Room creation returns 403

Ask the site administrator for the correct address to create a room. If it still shows 403, send them the site address and the error text.

<details>
<summary>Site administrators · Check allowed addresses</summary>

Piik rejects room creation from a browser address that the server has not allowed,
even when the page opens normally. The site administrator should:

1. Set `PUBLIC_BASE_URL` to the browser's site address, including the scheme and
   any non-default port, without a path.
2. Unset or empty `ALLOWED_ORIGINS` to use that address. If several addresses are
   needed, list every trusted origin explicitly, separated by commas. Check for
   an old `http://localhost:8787` override after copying a configuration example.
3. Restart Piik (recreate the container with `docker compose up -d` for Compose),
   reload the page and retry.

If the response says `Origin not allowed` with correct settings, check that the
reverse proxy preserves the browser's `Origin` header. A 403 from the proxy or
WAF itself needs its own logs; do not disable origin validation to bypass it.
See [Server deployment](../operations/self-hosting.md) for the configuration.

</details>

## Starting a share

[No picker](#no-screen-picker) · [Missing windows](#app-windows-or-screens-are-missing) ·
[Source selected, sharing fails](#sharing-does-not-start-after-source-selection) · [H264 failure](#h264-sharing-fails-on-windows)

When sharing fails, select the error icon below the TV. It opens the reason,
checks for that stage and **Copy failure details**; follow the checks before retrying.

![Sharing failure dialog with a sample capture error, suggested checks and the Copy failure details action.](../assets/guide/share-failure.en.png#gh-light-mode-only)
![Sharing failure dialog with a sample capture error, suggested checks and the Copy failure details action.](../assets/guide/share-failure.en.dark.png#gh-dark-mode-only)

*Sample App capture error. Your message and checks depend on what failed.*

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
| Cannot connect to Piik App | Confirm the App is running and this site is approved. Close unused Piik tabs using the App, then refresh the list; up to two pages can use the App's native capture or viewing at once. |
| Piik App and this page are incompatible | Update Piik App and reload the page. |
| Piik App capture is currently unavailable | Check the App diagnostics for capture or encoder availability. Review your encoding setting or use browser capture. |
| Could not read the screen and window list | Refresh to retry. If it keeps failing, export both the App and browser Debug reports. |
| No sources available | The list was read successfully, but this tab has no selectable sources. Check the other source tabs. |

Local-network permission lets the page contact App. For media failures after
connection, check [WebRTC settings](./network.md#browser-webrtc-restrictions).

### Sharing does not start after source selection

1. Click the error icon below the TV and copy the failure summary. For an App disconnect or timeout, check App is responding, click **App** at the top of the site and allow local network access when prompted.
2. If the selected source fails to start, try an ordinary window, then the **Browser** picker. If the browser cannot read it, keep the source open and allow screen recording. Close any app with exclusive access to the camera.
3. If only Windows App capture fails, try **Auto** or **VP8** and follow the [graphics checks](#h264-sharing-fails-on-windows). For a media connection error, check [WebRTC settings](./network.md#browser-webrtc-restrictions) and local network permission. For [HTTP 403](#room-creation-returns-403), check site configuration.

Still failing? Save [matching Web and App reports](#reporting-a-problem) with the selected source type and the copied summary.

### H264 sharing fails on Windows

1. **Compare codecs on the same source.** In **Sharing settings → Picture → Fine-tune picture**, change the
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

[No connection](#when-video-will-not-connect) · [Blur / stutter](#the-picture-is-blurry-or-keeps-freezing) ·
[Black game capture](#game-capture-is-black-or-sharing-stops) · [Washed-out HDR](#hdr-picture-looks-too-bright-or-washed-out) ·
[Capture border](#yellow-capture-border-on-windows) · [Fullscreen / sleep](#fullscreen-or-playback-after-sleep)

<span id="room-no-picture"></span>

### When video will not connect

1. Ask the Host to start sharing and check their preview. If it also stays black or frozen, [check the capture source](#sharing-does-not-start-after-source-selection).
2. If the preview works and the Viewer sees **No media route available**, select **Reconnect**. If unavailable, reopen the invitation and let the attempt finish.
3. Try a phone hotspot. If the picture appears, tell the administrator of the original network that you can enter the room but cannot receive video. See [network troubleshooting](./network.md).

If it still fails, save [diagnostic reports](#reporting-a-problem) from the Host and affected Viewer for the same attempt.

<span id="playback-stalls"></span>

<a id="picture-blurs-stutters-or-stops"></a>

### The picture is blurry or keeps freezing

1. When playback stalls, watch the Host preview at the same time. If it freezes too, check that the source is updating and whether the game is saturating the CPU or GPU. Try lowering resolution or frame rate in **Sharing settings → Picture**, one at a time.
2. If the preview stays smooth, ask another Viewer whether they see the pauses. If only your picture stalls periodically, try **Increase playback buffering** where available. Compare the same movement. Restore the previous setting if stalls persist or the extra delay affects controls, then compare another browser or hotspot.
3. If all Viewers are affected, check **Connection details → Video codec** on the Host. Windows Auto may select VP8 when H264 is unavailable, its check is incomplete or it cannot sustain the frame rate. Software encoding competes with the game for CPU time. For Browser capture, follow the [graphics checks](#h264-sharing-fails-on-windows) or compare App window/screen capture. Keep Auto or VP8 if the H264 check fails.

If sharing ended, read the reason below the TV. [Export reports before refreshing](#reporting-a-problem) from the Host, affected Viewer and any App handling capture.

### Game capture is black or sharing stops

Check that you selected the game's window or the screen displaying it, then try
the game's borderless window mode. Compare an ordinary window, and try both App
capture and the **Browser** source picker. Protected content may be unavailable
for capture.

If Piik returns to the start screen after you enter a game, read the reason below
the TV and follow [sharing startup checks](#sharing-does-not-start-after-source-selection).
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

<span id="mobile-stop"></span>

### Fullscreen or playback after sleep

To end a share from your phone, return to the sharing page and select **Stop sharing**. If you are controlling a desktop, use the drawer below the picture to access controls. See [remote control](./remote-control.md).

- **Playback controls are hidden:** tap the picture to bring them back. During
  remote control, use the drawer tab at the TV's bottom edge.
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

1. Unmute the video and turn up playback volume. Ask the Host to check that sound is enabled for the selected source.
2. On iPhone Safari, screen sharing excludes game audio. For camera video or OBS, select the audio input separately. See [sharing and playback](./sharing.md).
3. With Windows App screen capture and no application exclusions, check the game is playing through the default playback device. Route it there and restart sharing, or share the game window to capture its process audio.

If speech is missing, follow the [microphone and room voice checks](#cannot-hear-someone-speaking).

### Cannot hear someone speaking

1. Ask how the speaker joined. For **Include my microphone**, the Host checks **Sharing settings → Sound** and the Viewer checks [picture sound](#picture-but-no-source-sound).
2. For room voice, the Host selects **Open room voice** and both people join **Interact → Voice**. Each speaker turns on their microphone and checks site permission, input device and volume in **Voice settings**. Microphone access requires HTTPS or `localhost`.
3. Check whether you paused listening or muted that person locally. **Pause listening** leaves your own microphone on.

If voice reports a connection failure, compare another network and check [browser WebRTC settings](./network.md#browser-webrtc-restrictions).

### Echo or unwanted application audio

If a viewer hears their own voice coming back through the stream, keep room voice on for this check.

1. Ask the viewer to turn just that stream's playback volume to zero and speak. If the echo stops, turn the volume back up and continue to step 2. If it persists, check the microphones and monitoring settings below.
2. Have the host temporarily turn off the source audio, labeled **System sound** for a full-screen share. If the echo stops while the host can still hear the viewer in the call, the share is capturing room voices.

To keep both game audio and the conversation, select the game under **Apps / Windows** in the Windows App. For a full-screen share, use **Exclude application audio** and choose the window playing the call. If the game and the call use the same browser, share the game tab with tab audio. [Sharing sound settings](./sharing.md#exclude-a-voice-app-from-screen-audio)

If muting source sound leaves the echo audible, try turning off the host's **share microphone**, then have anyone using speakers switch to headphones. Check a virtual mixer's playback and monitoring outputs if one is in use.

### Microphone or remote controls are unavailable

1. Open the full HTTPS invitation on the Viewer’s device. For a local invitation, [confirm its certificate](#local-https-certificate-warning). Plain HTTP LAN pages support viewing, chat and listening. Microphone, camera and remote input require a secure context. Changing the URL prefix cannot enable HTTPS, and `localhost` refers to the current device.
2. For microphone access, check site permission and the selected input device. If the browser rejects the local certificate, use **Public invite** or a site with a trusted HTTPS certificate.
3. For remote control, ask the Host to share a desktop App window or screen and enable control, then request access. Request it again after a source change, share stop or disconnect. Android Viewers can control desktops. Android Hosts, Browser capture and camera sources cannot receive remote input.

If controls are still missing, update the Host App and site, refresh the Viewer page and repeat the [authorization steps](./room-tools.md#let-a-friend-control-your-shared-screen).

## Gamepads

### The gamepad does not respond

1. The Host shares an App window or screen and enables **Remote control**.
2. Check the Host against [supported platforms and gamepad setup](./remote-control.md#gamepads).
   The Host installs external drivers from the official source; Piik includes no
   input SDK or driver. Turn Remote control off and on after installation.
3. The Viewer connects a standard-layout controller and presses a button so the
   browser detects it, then obtains remote control. Piik automatically uses the
   first connected controller with the browser's standard mapping. Keep the viewing
   page focused and join the corresponding player in the game. If all controller
   slots are occupied, disconnect an unused controller or end that Viewer's remote control.

Viewers only need their browser. Driver checks and installation belong on the Host.

## Advanced network checks

If the page opens but picture or voice will not connect, use the [network guide](./network.md). Choose a section below:

### Campus networks and strict NAT

Choose a connection option for campus or work networks. [View steps](./network.md#campus-networks-and-strict-nat).

### Browser WebRTC restrictions

Check settings when the same invitation works in another browser. [View steps](./network.md#browser-webrtc-restrictions).

### STUN, IPv6 and router checks

Read discovery logs or check a router you manage. [View steps](./network.md#stun-ipv6-and-router-checks).

### Optional: a virtual LAN

Friends elsewhere cannot reach a local invitation, or direct media still will not
connect? A virtual LAN provides another connection option. [View steps](./network.md#optional-a-virtual-lan).

## Reporting a problem

Describe what you clicked, what you expected and what appeared. Include the exact error, time and device. If the Viewer cannot see the picture, ask the Host to note the time of the same attempt.

<details>
<summary>When a report is needed · Collect diagnostics</summary>

Include the Piik version, OS/browser, time, expected result and reproduction steps.
For capture problems, add the source type, codec, GPU/driver and whether another
source or VP8 works. For network problems, add the network type.

Enable diagnostics before reproducing once, then export before refreshing:

- **Web:** use the page's diagnostics button. A sharing failure's error icon below
  the TV also provides a copyable summary; it contains the Web version, message
  and code, without invitation links or source names.
- **Desktop App capture or remote control:** also enable **Debug launch** on the Host App's mode selection page,
  then press `D` in the terminal to export its report.
- **Connection failure:** collect the affected Viewer and Host reports for the
  same attempt. For self-hosted SFU, include the Server report too.

Reports stay on your device. Review private information before sharing them;
[diagnostics and export](../../cmd/piik-app/README.md#diagnostics) explains their contents.
If you cannot collect logs, send the full error text and reproduction steps.

For other guides, return to [the documentation home](./README.md).

</details>
