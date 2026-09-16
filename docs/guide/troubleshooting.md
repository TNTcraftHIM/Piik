# Troubleshooting

English · [简体中文](./troubleshooting.zh-CN.md) · [Documentation](./README.md)

Find the symptom below and try the suggested checks. Stop when it works;
collect a diagnostic report if the problem persists.

## Common problems

| What you see | Try this |
| --- | --- |
| Picture but no sound | Unmute the video. The host should choose a source with shareable audio; if sound was disabled, stop and start sharing with it enabled. App window/screen capture keeps that setting when switching sources. |
| No screen picker | Allow the browser or App to record the screen when the OS asks. Browser capture needs HTTPS or `localhost`; try sharing from a desktop computer. |
| No App windows or screens listed | Keep the App running and reopen its sharing page. Allow local-network access if asked, then refresh the source list. You can also choose **Browser** → **Browser picker** to use browser capture. If the problem persists, collect the Debug report described below. |
| App startup fails | Read the reason on the page and in the terminal. Reopen the App and enable the chip-shaped **Debug launch** control after the theme button before trying again. A failed startup then exports a report; its path appears in the terminal. |
| Local invitation will not open | Check that both devices are on the same network and can reach each other. Guest Wi-Fi or firewall rules can block local access. |
| Page opens but video will not connect | Use **Reconnect** if available, or refresh the viewing page. See [connection troubleshooting](#when-video-will-not-connect) if it still fails. |
| Sharing stops after sleep or suspension | Wake the device and return to the sharing tab; start sharing again if needed. Browser and OS suspension can interrupt capture or playback. |

For a bug report, include the version, OS/browser, what you expected, and how
to reproduce it. [Diagnostics and export](../../cmd/piik-app/README.md#diagnostics)
explains how to collect a local report and what to review before sharing it.

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
2. **Try another network.** For example, test a phone hotspot. If you use a VPN,
   proxy or WebRTC-blocking extension, check its UDP policy with the network
   administrator. See [browser connection settings](../../cmd/piik-app/README.md#chromium-webrtc-connections).
3. **Enable usable IPv6.** Check that your provider, router and device support it.
   When both peers have working IPv6, Piik can try that direct path alongside
   IPv4. It does not bypass firewall rules; keep IPv4 enabled too.
4. **Check your own router, if you manage it.** On a trusted home network,
   supported UPnP, PCP or NAT-PMP settings can let the App's native media path
   request a port mapping. Browser-only capture does not request these mappings.
   If a modem and router both perform NAT, follow your model's bridge/AP-mode
   instructions to remove the extra layer. Carrier-grade NAT is upstream of your
   router; ask your provider about available public IPv4 or IPv6 service.
   Back up settings before changing the router's operating mode.
5. **Invite a friend on another network.** A Viewer who can receive the picture
   and has spare forwarding capacity may give Piik another path to you. Piik
   chooses this automatically; extra people help only when those connections work.
6. **Use a site with media fallback.** Its operator must enable SFU forwarding,
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
