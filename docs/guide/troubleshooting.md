---
outline: 2
---

# Troubleshooting

English · [简体中文](./troubleshooting.zh-CN.md) · [Documentation](./README.md)

Find your symptom below. Try its checks in order and stop when it works.
If it persists, [save a diagnostic report](#reporting-a-problem) before refreshing.

## Common problems

- [Opening App and joining a room](#opening-app-and-joining-a-room): startup, invitation links, certificates and room access.
- [Starting a share](#starting-a-share): source lists, capture permissions and encoders.
- [Picture and playback](#picture-and-playback): connection, quality, games and fullscreen.
- [Sound and browser permissions](#sound-and-browser-permissions): source sound, voice, echo and remote control.
- [Gamepads](#gamepads): controller access, Host drivers and game recognition.
- [Advanced network checks](#advanced-network-checks): WebRTC, STUN, campus networks and virtual LANs.

## Opening App and joining a room

### App startup fails, or no page opens

1. Read the reason on the launch page and in the terminal. If the App is still
   running, copy its displayed address into your browser.
2. If Local mode lists several addresses, choose the adapter and IP that friends
   can reach. See [Local invitation checks](#local-invitation-will-not-open).
3. If startup still fails, retry with **Debug launch** enabled and save the complete
   error and an [App report](#reporting-a-problem).

### macOS blocks first launch

Current Mac builds are not Developer ID-signed or notarized. macOS can block
their first launch; the wording alone does not identify a damaged download.

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

App **Public invite** uses Cloudflare Tunnel to provide a temporary web address.
Reachability varies by network, and [Quick Tunnels have no uptime guarantee](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations).
`public invitation service exited before connecting` means the helper exited
before connecting; `exit status 1` alone does not identify the cause.
[Cloudflare error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/)
means that the address currently has no available tunnel connection. This differs
from a page that opens but reports **No media route available**.

1. **Viewers: confirm the link.** Ask the host to check that the App is running
   and the computer is awake, then send the current invitation. Use a new link
   after the App restarts; the old address may no longer work.
2. **Hosts: read the failure details.** Check that the complete App package was
   extracted. Save the full error from the launch page or terminal, including
   any detail after the exit code, and try again with **Debug launch**
   enabled.
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

Piik already enables HTTP/2 (TCP) fallback when QUIC (UDP) fails. Both use outbound
port `7844`. If neither path is reachable, repeated attempts cannot fix it;
loading ordinary websites does not establish that this port is accessible.
See [Cloudflare's connection troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/)
for the requirements. You do not need to open an inbound port on your router.

</details>

**To continue without a public invite:** keep App running, open
[Piik online](https://demo.piik.tv) or another reachable site, and
[authorize App capture](./getting-started.md#use-app-with-an-existing-site).
Send the new site's room invitation; the old link does not lead to this room.
Piik online needs no site passphrase and remains P2P-only, without SFU fallback.
If the page opens but video does not connect, follow
[media connection troubleshooting](#when-video-will-not-connect).
If the unavailable address is a self-hosted site rather than the App's
temporary address, ask that site's administrator to check its service.

### Local invitation will not open

If the browser times out before showing Piik, check web access first. P2P
connection has not started at this point.

1. Keep the host's App running. In **Local room**, select an adapter address
   friends can reach and send the full invitation link. Both devices need a
   reachable LAN or the same virtual LAN; guest Wi-Fi may isolate them.
2. On the Windows host, open **Windows Security → Firewall & network protection →
   Allow an app through firewall**. Check the currently running `piik-app.exe`
   and allow the network type in use. A virtual adapter may be classified as
   **Public**; advanced rules can restrict access to that adapter and subnet.
3. After extracting an update to another folder, check whether the rule still
   points to the old file. No prompt does not mean access is allowed: add the
   current App manually if needed. Keep the firewall on and allow the needed app.

If App reports **the local port is unavailable**, close an older Piik instance
using it. If another application needs that port, start Piik with `--port 9876`
and send the newly generated invitation. Both the web and local STUN ports must
be available; changing only the URL will not move the service.

Changing permissions may require an administrator; see
[Microsoft's instructions](https://support.microsoft.com/en-us/windows/security/firewall/risks-of-allowing-apps-through-windows-firewall).
If the page opens but video does not connect, continue with
[media connection checks](#when-video-will-not-connect).

### Local HTTPS certificate warning

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

### Room code does not work

Open the Host's current full invitation link first. A room code works only on
its original Piik site. A site with empty-room recycling may have reclaimed the
room; the Host can create a new one. See [joining a room](./getting-started.md#join-a-friends-room).

If all room codes on the site are in use, retry later or use another Piik site.
Administrators can configure [empty-room retention](../operations/self-hosting.md#1-configure-and-start-piik)
to reclaim unused codes. This is separate from the per-room Viewer limit.

### Room creation returns 403

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

## Starting a share

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

Local-network permission lets the page contact the App. It is separate from
the WebRTC media settings described below. An unreachable App alone does not
prove that permission was denied.

### Sharing does not start after source selection

Click the error icon below the TV for suggested checks, a copyable failure
summary and browser diagnostics.

- **App disconnected or request timed out:** check that the App is running and
  responding, then click **App** at the top of the site to connect. Allow local network
  access if the browser asks. A timeout alone does not establish a graphics fault.
- **App could not start the selected source:** try an ordinary window or screen,
  then compare with the **Browser** source picker. On Windows, try **Auto** or
  **VP8** and follow [graphics checks](#h264-sharing-fails-on-windows).
- **Browser cannot read the source or permission is missing:** keep the source
  open, allow screen recording and select the source again from the sharing page.
  For a camera, also check whether another application has exclusive use of it.
- **Media connection failed:** check [browser WebRTC settings](#browser-webrtc-restrictions)
  and local network permission. For **room creation HTTP 403**, check [site configuration](#room-creation-returns-403).


If it still fails, [collect matching Web and App reports](#reporting-a-problem)
with the copied failure summary and selected source type.

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

The Windows preference is a browser-side check, not a guarantee of H264 support.
Piik App selects its native encoder separately; Chrome's preference does not
select App's capture GPU. If it still fails, [save reports](#reporting-a-problem)
with the codec comparison. If both codecs fail, also check
[WebRTC restrictions](#browser-webrtc-restrictions).

## Picture and playback

### When video will not connect

**No media route available** means Piik has not found a working path to deliver
the picture to your device. Web pages and media use different connections;
the message alone does not identify the cause.

1. **Retry the viewing page.** Use **Reconnect** if available; otherwise refresh
   or reopen the invitation. Let each attempt finish. One or two fresh attempts
   are enough to compare; repeated refreshes cannot remove a network restriction.
2. **Check browser WebRTC settings.** Browser settings, VPNs and privacy extensions
   can block media for both Host and Viewer. Follow the [WebRTC checks](#browser-webrtc-restrictions).
3. **Try another network**, such as a phone hotspot. Check your VPN/proxy's UDP
   policy; ask the administrator on a managed network.
4. **Invite a friend on another network.** A Viewer who receives the picture and
   has spare forwarding capacity may give Piik another path to you. Piik chooses
   it automatically; extra people help only when those connections work.

Still failing? Continue with [advanced network checks](#advanced-network-checks)
and collect reports from the Host and affected Viewer for the same attempt.

### Picture blurs, stutters or stops

Brief blur can result from automatic adjustments to network or encoding load.
If it recurs or never recovers, compare the following:

1. **Identify who is affected.** Is it the host's preview, every viewer or just
   one viewer? Note the time and whether it recovers on its own. A clear host
   preview does not establish that viewers' connections are healthy.
2. **Change one thing at a time.** The host can try a lower resolution or frame
   rate under **Sharing settings → Picture**, and check CPU/GPU load while the game runs.
   An affected viewer can compare another browser or a phone hotspot. Increasing
   bitrate does not necessarily help.
3. **Check the actual codec.** Open the host's **Connection details** and
   read **Video codec**. On Windows, Auto may select VP8 when H264 is unavailable,
   its check cannot finish, or it cannot sustain the selected frame rate.
   Software encoding competes with the game for CPU time. For **Browser** capture,
   follow the [graphics checks](#h264-sharing-fails-on-windows), or compare the App's
   window/screen capture. The App tries available hardware encoders independently.
   VP8 alone does not establish a GPU fault; forcing H264 after a failed check may
   make performance worse.
4. **Save reports from the affected period.** Follow [report collection](#reporting-a-problem) for the Host and affected Viewer;
   App capture also needs an App report. Try **Reconnect** if the picture does
   not recover. Export before refreshing.

If sharing stopped altogether, read the reason below the TV and follow
[sharing startup checks](#sharing-does-not-start-after-source-selection). If the
host is still sharing but viewers cannot receive video, follow [connection checks](#when-video-will-not-connect).

### Game capture is black or sharing stops

Check that you selected the game's window or the screen displaying it, then try
the game's borderless window mode. Compare an ordinary window, and try both App
capture and the **Browser** source picker. Protected content may be unavailable
for capture; one game failing does not establish that every source is affected.

If Piik returns to the start screen after you enter a game, read the reason below
the TV and follow [sharing startup checks](#sharing-does-not-start-after-source-selection).
Include the game and window mode in your [report](#reporting-a-problem).

### HDR picture looks too bright or washed out

Windows App capture through **Apps / Windows** or **Screens** converts HDR to SDR
for viewers. The **Browser** picker uses browser capture instead; some HDR sources
can look overexposed. This is a known limitation. Try the App categories above,
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
capture indicators too. The author shows it working on Windows 10 21H2; this
procedure has not been tested with Piik on a Windows 10 device.

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

- **Phone fullscreen has black bars:** video preserves its proportions. Try
  landscape orientation, or select **Fill** or **Stretch** under **Playback settings**.
- **Fullscreen button does not work:** use the playback bar's **Fullscreen** button.
  System video fullscreen depends on the browser; see [viewing controls](./getting-started.md#join-a-friends-room).
- **Sharing stops after sleep or suspension:** wake the device and return to the
  sharing tab. Start sharing again if needed; browser and OS suspension can
  interrupt capture or playback.

## Sound and browser permissions

### Picture but no source sound

1. Unmute the video and check your playback volume.
2. The Host should select a source with shareable audio and enable its sound in
   the source picker. Available sound depends on the source and platform.
3. Camera video and microphone inputs are selected separately. For a built-in
   camera microphone or OBS audio, see [camera and audio inputs](./sharing.md#cameras-and-virtual-audio-inputs).

### Cannot hear someone speaking

In voice-capable builds:

1. Both people join **Interact → Voice**; the Host selects **Open room voice** first.
   Joining only starts listening. Each speaker must turn on their own microphone.
2. The speaker checks browser microphone permission, input device and input volume
   in **Microphone settings**. Microphone access needs HTTPS or `localhost`.
3. Check whether you paused listening or muted that person locally. These controls
   are separate from video mute; **Pause listening** leaves your microphone on.

If voice reports a connection failure, compare [WebRTC settings](#browser-webrtc-restrictions)
and another network. Picture playback alone does not establish that voice works.
For feature availability, see [room voice](./room-tools.md#room-voice).

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
3. For remote control, update the Host's App and the site, then refresh the Viewer
   page. The Host must use App window/screen capture and enable control; Browser
   and camera capture cannot receive remote input. Follow the
   [authorization steps](./room-tools.md#let-a-friend-control-your-shared-screen).

If your browser cannot accept the local certificate, use a reachable **Public
invite** or an HTTPS site with a trusted certificate.

## Gamepads

### Use gamepad is missing, or the game does not respond

1. The Host shares an App window or screen and enables **Remote control → Play together**.
2. Check the Host against [supported platforms and gamepad setup](./remote-control.md#gamepads).
   The Host installs external drivers from the official source; Piik includes no
   input SDK or driver. Turn Play together off and on after installation.
3. The Viewer connects a controller and presses a button so the browser detects it,
   then selects **Use gamepad** and obtains control. Join the corresponding player
   in the game; free a controller slot if all are occupied.

Viewers only need their browser. Driver checks and installation belong on the Host.

## Advanced network checks

### Browser WebRTC restrictions

WebRTC carries Piik's picture and sound. Disabling it or blocking non-proxied UDP
can prevent viewing and even the local Browser-to-App media connection. Successful
source selection does not prove that connection works. Hiding local IP addresses
alone does not necessarily block WebRTC.

1. Open the same invitation in a browser profile with default settings and no
   VPN/privacy extensions. If that works, check the original profile's WebRTC or
   IP-leak protection settings.
2. Restore a policy that allows WebRTC UDP. A policy named `disable_non_proxied_udp`
   is restrictive; the browser default is a useful comparison. Vivaldi exposes
   **Settings → Privacy and Security → WebRTC IP Handling → Broadcast IP for Best WebRTC Performance**.
   Chrome extensions can control this policy even without a visible browser switch.
3. Reload the affected Piik page and retry. If a school or company manages the
   setting, ask its administrator to review it.

Allowing these connections can expose network addresses to WebRTC peers; change
only the relevant setting. See [Chrome's policy reference](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)
and [Vivaldi's privacy settings](https://help.vivaldi.com/desktop/privacy/privacy-settings/).

### STUN, IPv6 and router checks

NAT lets several devices share an Internet address. Some routers or provider
networks make direct connections harder; firewalls and browser policies can
also block media. Check the parts you manage:

1. **STUN discovery:** STUN finds addresses for direct connections; it does not
   relay the picture. An unreachable service can leave chat working while media
   fails. App Public invite already uses several discovery services; one STUN
   error does not mean every path failed. Self-hosted administrators should check
   that `STUN_URLS` points to reachable UDP services. HTTP reverse proxies do not
   forward STUN. App users can set [`PIIK_STUN_URLS`](../standards/configuration.md#piik-app-configuration)
   before starting Public invite to replace all built-in discovery addresses.
   Choose trusted providers, since they see participants' public IP addresses.
2. **IPv6:** when the provider, router and both devices have usable IPv6, Piik can
   try that direct path alongside IPv4. Keep IPv4 enabled too; IPv6 still obeys
   firewall rules.
3. **Home router:** supported UPnP, PCP or NAT-PMP can let App's native media path
   request port mappings. Browser-only capture does not request them. If both a
   modem and router perform NAT, your model's bridge/AP-mode instructions may
   remove a layer. Back up settings before changing its operating mode.
   Carrier-grade NAT is upstream; ask your provider about public IPv4 or IPv6.

Router menus vary. See manufacturer guidance on
[IPv6](https://support.google.com/googlehome/answer/6361450),
[UPnP](https://support.google.com/googlehome/answer/6274337), and
[double NAT](https://www.tp-link.com/us/support/faq/3113/), or the
[WebRTC connection guide](https://webrtc.org/getting-started/peer-connections)
for discovery details. Compare both peers' reports before assigning a cause.

### Campus networks and strict NAT

Compare the same invitation on a phone hotspot first. If it works there, focus
on the original network's shared gateway or firewall restrictions.

For regular use, an operator can [enable SFU media fallback](../operations/self-hosting.md#optional-media-fallback)
on a self-hosted Piik site. If it offers **Privacy mode**, the Host must turn it
off before sharing; a site configured for **Server media** already requires SFU.
Keep App running, open the new site and select **App** to approve local access,
then send that site's invitation.

The public `demo.piik.tv` site and App **Public invite** provide P2P only. Both P2P
and SFU media currently need UDP. Deploying a server does not bypass a network
that blocks media UDP entirely; use another network or ask its administrator.

### Optional: a virtual LAN

If hosting a server is inconvenient, you can also try a third-party virtual LAN
to put your friends on the same virtual network. For example,
[UU's official guide (Chinese)](https://uu.163.com/blog/lan-multiplayer-guide-net.html)
offers LAN and general-purpose multiplayer rooms. Choose general-purpose LAN
networking, rather than acceleration limited to one game. The tool must provide
reachable virtual IPv4 addresses and carry both Piik's web traffic and WebRTC UDP.

1. Everyone runs the networking tool and joins the same virtual LAN.
2. If its virtual adapter and IP appear in Piik App's **Local room** address list,
   the host selects that address and starts sharing. If the page will not open,
   use [Local invitation checks](#local-invitation-will-not-open) to review
   Windows firewall permissions for that virtual network.
3. Send friends the full Piik invitation using that address, not a `localhost`
   address or just a room code. Check picture and sound after the page opens;
   a reachable web page does not establish that media UDP works too.
4. Keep the networking tool running on every device. If its virtual IP changes,
   select the new address in the App and send a new invitation.

**Local room** sends an HTTPS invitation on the selected virtual IP. Confirm its
[local certificate](#local-https-certificate-warning) on first access. Microphone,
camera and remote control can then work without a public tunnel, just as on an
ordinary LAN. If unavailable, check [browser permissions](#microphone-or-remote-controls-are-unavailable).
Connection details show the selected media addresses.

Use an updated App for address discovery on routed virtual LANs. This method
needs a usable virtual address and media UDP; it cannot work with tools that
forward only game traffic. Firewalls, browser discovery and the third-party
service still affect availability. Join only with trusted friends.

[ZeroTier](https://docs.zerotier.com/start/) and
[Tailscale](https://tailscale.com/docs/how-to/quickstart) also create private
networks. Check device support and the requirements above; these alternatives
have not been tested with Piik.

For administrators with a public server, the [frp recipe](../operations/self-hosting.md#optional-forward-an-existing-server-with-frp)
forwards an existing site's web and SFU endpoints through frps. Forwarding the
web page alone does not forward WebRTC media.

## Reporting a problem

Include the Piik version, OS/browser, time, expected result and reproduction steps.
For capture problems, add the source type, codec, GPU/driver and whether another
source or VP8 works. For network problems, add the network type.

Enable diagnostics before reproducing once, then export before refreshing:

- **Web:** use the page's diagnostics button. A sharing failure's error icon below
  the TV also provides a copyable summary; it contains the Web version, message
  and code, without invitation links or source names.
- **App capture:** also enable **Debug launch** on the App's mode selection page,
  then press `D` in the terminal to export its report.
- **Connection failure:** collect the affected Viewer and Host reports for the
  same attempt. For self-hosted SFU, include the Server report too. Host upload or
  subscription setup alone does not prove that the Viewer received the picture.

Reports stay on your device. Review private information before sharing them;
[diagnostics and export](../../cmd/piik-app/README.md#diagnostics) explains their contents.
You can still report without logs; a generic failure screenshot alone may not
identify the failing stage.

For other guides, return to [the documentation home](./README.md).
