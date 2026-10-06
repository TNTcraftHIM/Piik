# Troubleshooting

English · [简体中文](./troubleshooting.zh-CN.md) · [Documentation](./README.md)

Find the symptom below and try the suggested checks. Stop when it works;
collect a diagnostic report if the problem persists.

## Common problems

| What you see | Try this |
| --- | --- |
| App startup fails, or no page opens automatically | Read the reason on the page and in the terminal. If the App is still running, copy its address into your browser. See [App diagnostics](../../cmd/piik-app/README.md#diagnostics) to collect a report; if Local mode lists several addresses, choose an adapter and IP on the launch page. |
| Public invitation fails to start, or a link shows 1033 | Check the host's App and current link using [public invitation troubleshooting](#public-invitation-fails-or-shows-1033). |
| Local invitation will not open | Check that both devices are on the same network and can reach each other. Guest Wi-Fi or firewall rules can block local access. |
| Room code says the room does not exist | Open the host's current full invitation link. Codes work only on their original site; a site with empty-room recycling may also have reclaimed it. The host can create a new room; see [joining a room](./getting-started.md#join-a-friends-room). |
| Cannot create a room (403) | On a self-hosted site, ask the administrator to check the [allowed site address](#room-creation-returns-403). |
| All room codes are in use | Retry later or use another Piik site. Administrators can enable [empty-room retention](../operations/self-hosting.md#1-configure-and-start-piik) to reclaim unused codes. This is separate from the per-room Viewer limit. |
| No screen picker | Allow the browser or App to record the screen when the OS asks. Browser capture needs HTTPS or `localhost`; try sharing from a desktop computer. |
| No App windows or screens listed | Check the message in the source picker, then follow [App source troubleshooting](#app-windows-or-screens-are-missing). **Browser** → **Choose what to share** opens the browser's screen, window or tab chooser. |
| Sharing fails after selecting a source | Click the error icon below the TV for details and guidance, then follow [sharing startup checks](#sharing-does-not-start-after-source-selection). |
| H264 fails to start, or sharing stops just after source selection | Try **Auto** or **VP8**, then follow [Windows H264 and graphics checks](#h264-sharing-fails-on-windows). |
| Game capture is black, shows only the desktop, or stops when entering the game | Compare sources and window modes using [game capture checks](#game-capture-is-black-or-sharing-stops). |
| HDR picture looks too bright or washed out | On Windows, try App capture or temporarily turn off HDR; see [HDR capture](#hdr-picture-looks-too-bright-or-washed-out). |
| Yellow outline around the shared window or screen | This is Windows' capture indicator. See [capture borders](#yellow-capture-border-on-windows) for Windows 11 controls and an optional Windows 10 workaround. |
| Picture but no source sound | Unmute the video. The host should choose a source with shareable audio and enable sound in the source picker. Camera video and audio inputs are selected separately; see [audio settings](./getting-started.md#add-your-voice). |
| Cannot hear the host's voice | The host can enable **Microphone** below the picture, then check the selected input and its volume in **Settings → Sound**. Check the device connection and microphone permission. If the control is unavailable, update the App and refresh the page. |
| Screen sharing includes a voice app's audio | Windows App screen capture can [exclude application audio](./getting-started.md#exclude-a-voice-app-from-screen-audio). This does not remove echo from speakers picked up by a microphone. |
| Page opens but video will not connect | Use **Reconnect** if available, or refresh the viewing page. See [connection troubleshooting](#when-video-will-not-connect) if it still fails. |
| WebRTC or IP-leak protection is enabled | Check whether it blocks media connections using [browser WebRTC settings](#browser-webrtc-restrictions). |
| Connection fails on a campus or restricted network | Compare with a phone hotspot, then consider a [site with SFU forwarding](#campus-networks-and-strict-nat). |
| Picture repeatedly blurs, stutters or stops | Identify who is affected, then follow [picture quality and interruption checks](#picture-blurs-stutters-or-stops). |
| Phone fullscreen has black bars, or the button does not work | Video keeps its proportions; try landscape orientation and the playback bar's **Fullscreen** button. System video fullscreen depends on the browser. See [viewing controls](./getting-started.md#join-a-friends-room). |
| Sharing stops after sleep or suspension | Wake the device and return to the sharing tab; start sharing again if needed. Browser and OS suspension can interrupt capture or playback. |

For a bug report, include the version, OS/browser, what you expected, and how
to reproduce it. [Diagnostics and export](../../cmd/piik-app/README.md#diagnostics)
explains how to collect a local report and what to review before sharing it.

## Sharing does not start after source selection

The error icon below the TV explains the current failure. Click it for suggested
checks, a copyable failure summary and browser diagnostics. The summary contains
the Web version, message and error code, without invitation links or source names.

- **App disconnected or request timed out:** check that the App is running and
  responding, open this site from the App, then refresh. Allow local network
  access if the browser asks. A timeout alone does not establish a graphics fault.
- **App could not start the selected source:** try an ordinary window or screen,
  then compare with the **Browser** source picker. On Windows, try **Auto** or
  **VP8** and follow [graphics checks](#h264-sharing-fails-on-windows).
- **Browser cannot read the source or permission is missing:** keep the source
  open, allow screen recording and select the source again from the sharing page.
  For a camera, also check whether another application has exclusive use of it.
- **Media connection failed:** check [browser WebRTC settings](#browser-webrtc-restrictions)
  and local network permission. For **room creation HTTP 403**, use the next section.

Stop when sharing works. Otherwise, enable diagnostics before reproducing it once:
the Web button collects browser reports only. For App capture, also enable
**Debug launch** on its mode selection page, then press `D` in the terminal to export.
Send the reports from that attempt with the copied failure summary and the source
type you selected. You can still report without logs; a generic failure screenshot
alone usually cannot distinguish capture, encoding and connection causes.
Logs stay on your device; review private information before sharing them.
See [diagnostics and export](../../cmd/piik-app/README.md#diagnostics) for details.

## Room creation returns 403

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

## App windows or screens are missing

Keep Piik App running on the computer where you are sharing. Open the current
site from the App; for a hosted site, use the App's **Site** mode with that
site's address. If the browser asks for local-network access, allow it, then
refresh the source list. If access was previously blocked, review this site's
browser permissions first.

The source picker distinguishes these outcomes:

| Message | Next step |
| --- | --- |
| Cannot connect to Piik App | Confirm the App is running and opened this site. Close unused Piik tabs using the App, then refresh the list; up to two pages can use the App's native capture or viewing at once. |
| Piik App and this page are incompatible | Update Piik App and reload the page. |
| Piik App capture is currently unavailable | Check the App diagnostics for capture or encoder availability. Review your encoding setting or use browser capture. |
| Could not read the screen and window list | Refresh to retry. If it keeps failing, export both the App and browser Debug reports. |
| No sources available | The list was read successfully, but this tab has no selectable sources. Check the other source tabs. |

Local-network permission lets the page contact the App. It is separate from
the WebRTC media settings described below. An unreachable App alone does not
prove that permission was denied.

## H264 sharing fails on Windows

If selecting a window or screen returns you to the start screen, or reports a
sharing failure, it may involve capture, encoding or the Browser-to-App media
connection. The message alone does not identify a graphics-driver problem.

1. **Compare codecs on the same source.** In **Settings → Connection & encoding**, change the
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
Piik App selects its native encoder separately; changing Chrome's GPU preference
does not select the App's capture GPU. If App capture still fails, keep the codec
comparison and export the App and browser reports for the same attempt. Include
your GPU model, driver version, source type and whether VP8 works. If both codecs
fail, also check [WebRTC restrictions](#browser-webrtc-restrictions).

## Game capture is black or sharing stops

Check that you selected the game's window or the screen displaying it, then try
the game's borderless window mode. Compare an ordinary window, and try both App
capture and the **Browser** source picker. Protected content may be unavailable
for capture; one game failing does not establish that every source is affected.

If Piik returns to the start screen after you enter a game, read the reason below
the TV and follow [sharing startup checks](#sharing-does-not-start-after-source-selection).
Include the game, window mode, source type, codec and matching App/browser reports
in your feedback. A missing picture alone does not identify an encoder fault.

## HDR picture looks too bright or washed out

Windows App capture through **Apps / Windows** or **Screens** converts HDR to SDR
for viewers. The **Browser** picker uses browser capture instead; some HDR sources
can look overexposed. This is a known limitation. Try the App categories above,
or temporarily turn off HDR in Windows display settings and select the source again.
Higher resolution or bitrate cannot restore clipped highlights.

If the picture still looks wrong, report the source type, HDR setting, GPU and
display model, with a comparison of the source and viewer pictures. Technical
background is in [HDR capture notes](../research/media-fidelity.md#hdr-to-sdr).

## Yellow capture border on Windows

Windows draws this outline to identify the window or display being captured.
On supported Windows versions, the App source picker offers **Show capture border**,
off by default. Windows permissions or another active capture can still require
the border. Windows 10 does not provide this control for its capture API.

### Windows 11: the border is still visible

1. Select **Apps / Windows** or **Screens** in Piik and leave **Show capture border**
   off. A Browser-selected source uses the browser's own capture indicator.
2. Stop other apps or tabs capturing the same window/display, then restart sharing.
3. If Windows denied borderless capture, review **Screenshot borders** in Windows
   privacy settings. Its settings page can also be opened with
   `ms-settings:privacy-graphicscapturewithoutborder` from **Win+R**, when available.

Windows requires consent and can retain the border when another capture requests
it ([Microsoft's API documentation](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)).
If it persists, include the Windows version, selected source type and an
[App diagnostic report](../../cmd/piik-app/README.md#diagnostics) with your feedback.

### Optional Windows 10 workaround

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

## Public invitation fails or shows 1033

App **Public invite** uses Cloudflare Tunnel to provide a temporary web address.
`public invitation service exited before connecting` means the helper exited
before connecting; `exit status 1` alone does not identify the cause.
[Cloudflare error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/)
means that the address currently has no available tunnel connection. This differs
from a page that opens but reports **No media route available**.

1. **Viewers: confirm the link.** Ask the host to check that the App is running
   and the computer is awake, then send the current invitation. Use a new link
   after the App restarts; the old address may no longer work.
2. **Hosts: read the terminal error.** Check that the complete App package was
   extracted. Save the full startup error and try again with **Debug launch**
   enabled. The App retries early tunnel-process exits within its startup deadline.
3. **Compare networks.** Try a phone hotspot. Check whether DNS, a proxy or a
   firewall blocks Cloudflare Tunnel; adjust only relevant rules. Ask the
   administrator about a school or workplace network.

If it keeps failing, you can share through the [online site or an existing site](./getting-started.md#share-from-an-existing-site).
Include the App version, failure time and [App diagnostic report](../../cmd/piik-app/README.md#diagnostics)
in feedback. If the unavailable address is a self-hosted site rather than the App's
temporary address, ask that site's administrator to check its service.

## Picture blurs, stutters or stops

Brief blur can result from automatic adjustments to network or encoding load.
If it recurs or never recovers, compare the following:

1. **Identify who is affected.** Is it the host's preview, every viewer or just
   one viewer? Note the time and whether it recovers on its own. A clear host
   preview does not establish that viewers' connections are healthy.
2. **Change one thing at a time.** The host can try a lower resolution or frame
   rate under **Settings → Picture**, and check CPU/GPU load while the game runs.
   An affected viewer can compare another browser or a phone hotspot. Increasing
   bitrate does not necessarily help.
3. **Save reports from the affected period.** Enable diagnostics on the host and
   affected viewer pages before reproducing; App capture also needs an App report.
   Try **Reconnect** if the picture does not recover. Export before refreshing.

If sharing stopped altogether, read the reason below the TV and follow
[sharing startup checks](#sharing-does-not-start-after-source-selection). If the
host is still sharing but viewers cannot receive video, continue with the checks below.

## When video will not connect

**No media route available** means Piik has not found a working path to deliver
the picture to your device. Loading the page and receiving media use different
connections, so one can work while the other fails.

NAT (Network Address Translation) lets several devices share an Internet address.
Routers and providers differ in how they map addresses and admit incoming traffic;
some combinations make direct connections difficult. Firewalls and browser
policies can also block media. The message alone does not identify the cause.

Try these in order, stopping when the picture arrives:

1. **Retry the viewing page.** Choose **Reconnect** if it is available. If it is
   disabled or does not help, refresh the viewing page or reopen the invitation.
   Let each connection attempt finish. One or two fresh attempts can be worth
   trying; repeated refreshes cannot remove a network restriction.
2. **Check browser WebRTC settings.** Browser settings or VPN/privacy extensions
   can block media even while the page loads. This affects both sharing and viewing;
   follow [browser WebRTC checks](#browser-webrtc-restrictions) below.
3. **Try another network.** For example, test a phone hotspot. If you use a VPN
   or proxy, check its UDP policy; ask the administrator on a managed network.
4. **Enable usable IPv6.** Check that your provider, router and device support it.
   When both peers have working IPv6, Piik can try that direct path alongside
   IPv4. It does not bypass firewall rules; keep IPv4 enabled too.
5. **Check your own router, if you manage it.** On a trusted home network,
   supported UPnP, PCP or NAT-PMP settings can let the App's native media path
   request a port mapping. Browser-only capture does not request these mappings.
   If a modem and router both perform NAT, follow your model's bridge/AP-mode
   instructions to remove the extra layer. Carrier-grade NAT is upstream of your
   router; ask your provider about available public IPv4 or IPv6 service.
   Back up settings before changing the router's operating mode.
6. **Invite a friend on another network.** A Viewer who can receive the picture
   and has spare forwarding capacity may give Piik another path to you. Piik
   chooses this automatically; extra people help only when those connections work.
7. **Use a site with media fallback.** Its operator must enable SFU forwarding.
   If the site offers **Privacy mode**, the Host must turn it off before sharing.
   Sites configured for **Server media** already require SFU. The public
   `demo.piik.tv` site and the App's **Public invite** mode do not provide SFU.
   [Self-hosting](../operations/self-hosting.md#optional-media-fallback) is an
   advanced option. Both P2P and SFU media currently use UDP; a network that blocks
   UDP entirely still needs a different network or an administrator's help.

Router menus vary by model. These manufacturer guides explain
[IPv6 prerequisites](https://support.google.com/googlehome/answer/6361450),
[UPnP](https://support.google.com/googlehome/answer/6274337), and
[double NAT with a modem and router](https://www.tp-link.com/us/support/faq/3113/).
The [WebRTC connection guide](https://webrtc.org/getting-started/peer-connections)
explains discovery and connection checks in more technical detail.

If these steps do not help, collect a [Debug report](../../cmd/piik-app/README.md#diagnostics)
from the affected Viewer and, if possible, the Host for the same attempt. Include
the time, Piik version and network type when reporting the problem.

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

### Campus networks and strict NAT

A campus network can work with Piik, but a shared Internet gateway or restrictive
firewall may make direct connections harder. Try a phone hotspot first: if the
same invitation works there, focus on the original network's restrictions.

For regular use, consider **self-hosting a Piik site with SFU media forwarding**.
This gives viewers a server path when direct connections fail. Follow the
[deployment guide](../operations/self-hosting.md#optional-media-fallback), including
its public-address and UDP-port requirements. The Host can then open that site
through the App's **Site** mode and send invitations from the new site.

The public demo and App Public invite mode remain P2P-only. SFU also requires
usable UDP: when the network blocks UDP entirely, use another network or ask the
administrator for access. Deploying a server alone does not remove that restriction.

Ready to host a site for your group? Follow [self-hosting](../operations/self-hosting.md).
For other guides, return to [the documentation home](./README.md).
