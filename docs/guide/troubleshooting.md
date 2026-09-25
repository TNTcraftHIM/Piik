# Troubleshooting

English · [简体中文](./troubleshooting.zh-CN.md) · [Documentation](./README.md)

Find the symptom below and try the suggested checks. Stop when it works;
collect a diagnostic report if the problem persists.

## Common problems

| What you see | Try this |
| --- | --- |
| Picture but no source sound | Unmute the video. The host should choose a source with shareable audio and enable sound in the source picker. |
| Cannot hear the host's voice | The host can enable **Microphone** below the picture, then check the selected input and its volume in **Sharing settings → Sound**. Check the device connection and microphone permission. If the control is unavailable, update the App and refresh the page. |
| No screen picker | Allow the browser or App to record the screen when the OS asks. Browser capture needs HTTPS or `localhost`; try sharing from a desktop computer. |
| No App windows or screens listed | Check the message in the source picker, then follow [App source troubleshooting](#app-windows-or-screens-are-missing). **Browser** → **Browser picker** also offers browser capture. |
| Yellow outline around the shared window or screen | This is Windows' capture indicator. See [capture borders](#yellow-capture-border-on-windows) for Windows 11 controls and an optional Windows 10 workaround. |
| App startup fails | Read the reason on the page and in the terminal. Reopen the App and enable the chip-shaped **Debug launch** control after the theme button before trying again. A failed startup then exports a report; its path appears in the terminal. |
| Local invitation will not open | Check that both devices are on the same network and can reach each other. Guest Wi-Fi or firewall rules can block local access. |
| Cannot create a room (403) | On a self-hosted site, ask the administrator to check the [allowed site address](#room-creation-returns-403). |
| Page opens but video will not connect | Use **Reconnect** if available, or refresh the viewing page. See [connection troubleshooting](#when-video-will-not-connect) if it still fails. |
| Sharing stops after sleep or suspension | Wake the device and return to the sharing tab; start sharing again if needed. Browser and OS suspension can interrupt capture or playback. |

For a bug report, include the version, OS/browser, what you expected, and how
to reproduce it. [Diagnostics and export](../../cmd/piik-app/README.md#diagnostics)
explains how to collect a local report and what to review before sharing it.

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
2. **Check WebRTC settings in the viewing browser.** A browser setting or VPN/privacy
   extension that disables WebRTC or non-proxied UDP can prevent viewing, even
   while the page loads. Merely hiding local IP addresses does not necessarily
   block WebRTC. Try the same invitation in a browser profile without those
   extensions, or review the specific WebRTC setting, then reload Piik.
   See [browser connection settings](../../cmd/piik-app/README.md#chromium-webrtc-connections)
   for examples and the privacy tradeoff; keep unrelated protections enabled.
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
7. **Use a site with media fallback.** Its operator must enable SFU forwarding,
   and the Host must turn off **Privacy mode** before sharing. The public
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

Ready to host a site for your group? Follow [self-hosting](../operations/self-hosting.md).
For other guides, return to [the documentation home](./README.md).
