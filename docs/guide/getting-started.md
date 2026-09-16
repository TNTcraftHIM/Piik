# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Back to Piik](../../README.md)

Piik shares one person's screen with up to 20 invited viewers. This guide covers
watching, using Piik online, using Piik App and sharing through an existing site.

[Join a room](#join-a-friends-room) · [Use online](#use-piik-online) ·
[Piik App](#share-with-piik-app) · [Existing site](#share-from-an-existing-site) ·
[Troubleshooting](#when-something-gets-in-the-way)

Viewers need a browser and an invitation. To start sharing, download Piik App
and choose **Public invite**. To share without installing, open
[Piik online](https://demo.piik.tv) and create a room in your browser.

## Join a friend's room

1. Open the invitation link your friend sent in a desktop or mobile browser.
2. Wait for their screen to appear. If the browser blocks autoplay, press **Play**.
3. Move the pointer over the picture or tap it to show the playback bar.

The playback bar controls only your own picture and sound.
On a computer, click the picture to pause or resume; double-click to enter or
leave fullscreen where supported. On a phone, tap the picture to show the bar
and use its buttons. Safari may show system controls in video fullscreen.

<details>
<summary>Playback controls, at a glance</summary>

| Control | What it does |
| --- | --- |
| **Theater mode** | Expands the picture inside the browser tab. |
| **Fullscreen** | Fills your screen. |
| **Picture in picture** | Opens a floating video where supported. |
| **Volume** | Goes up to 200% with audio boost, or 100% otherwise. Lower it if the sound distorts. |

</details>

With just a four-digit room code, open the same Piik site and choose
**Join a room**. You may need the site's passphrase and the room's password.
The host decides whether code entry is available; ask for an invitation link if
you cannot join by code.

If an old link no longer works, ask the host for the current invitation.
App Local rooms and temporary public invitations end when that App run stops.

## Use Piik online

1. Open [demo.piik.tv](https://demo.piik.tv) in a desktop browser that supports
   screen sharing.
2. Select **Start sharing**, choose a screen, window or tab, and enable audio if
   needed and offered by the browser.
3. Confirm the preview and select **Copy invite link**. Open that link on a
   second device or send it to a friend.
4. Select **Stop sharing** when finished.

The online version is provided by the project. Media travels only between participants (P2P);
restrictive networks may load the page but block video.

## Share with Piik App

1. Download a **`piik-app`** archive for your platform from
   [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases) or the
   [Gitee mirror](https://gitee.com/TNTcraftHIM/Piik/releases). Extract the whole
   archive and keep its directory structure intact.
2. Open `piik-app.exe` on Windows, `Piik App.app` on macOS, or `./piik-app` on Linux.
   The launcher opens in your system browser.
3. Choose **Public invite** for friends outside your local network, then select
   **Open Piik**. Other modes are explained below.
4. Choose **Start sharing**, then select **Browser**, **Apps / Windows**, or
   **Screens** as available. Pick the actual source and sound option.
5. Copy and send the room invitation. Keep both the App and sharing tab open.

| Filename contains | Platform |
| --- | --- |
| `windows-amd64` | Windows x64 |
| `darwin-arm64` | Apple silicon; native capture requires macOS 13+ |
| `linux-amd64` | Linux x64 |

Windows App and browser sharing are the primary tested paths. The macOS and
Linux apps have not yet been tested on physical devices;
[test results and feedback are welcome](https://github.com/TNTcraftHIM/Piik/issues).
Linux native capture also needs [system components](../../native/capture/linux/README.md).
See the [App guide](../../cmd/piik-app/README.md) for package and runtime details.

### Choose an App mode

| Mode | When to choose it | What to keep in mind |
| --- | --- | --- |
| **Local room** | Friends are on the same local network. | If several entries appear under **Local invitation address**, choose the interface and IP on your friends' network. Your computer must be reachable from theirs. A local site passphrase is optional. |
| **Public invite** | Friends are elsewhere and you want a temporary invitation. | Needs Internet access. The public address lasts for this App run. |
| **Connect to Site** | Your group already has a Piik site. | Enter its address; the App adds capture capabilities to the site's sharing page. |

For **Connect to Site**, enter the full site address, such as
`https://demo.piik.tv`, add its passphrase if required, then choose **Open Piik**.
After opening the site through the App once, the same browser remembers that
entry. Keep the App running with that site configured and you can visit the
address directly. **Start sharing** opens the selector; choose **Apps / Windows**
or **Screens** for App capture. Allow local-network access if the browser asks.
In another browser, in a private window, or after clearing site data, enter through
the App again. For a different site, update the address in the App first.

**A page that opens does not guarantee a video connection.** Public invite gives
your room a temporary web address; picture and sound still travel between
participants. This mode has no media-server fallback, and the temporary address
has no uptime guarantee. All modes need a working UDP media path.
The [App guide](../../cmd/piik-app/README.md#modes) explains the connection setup.

## Share from an existing site

You need an existing HTTPS site running Piik Server, provided by a friend or
administrator. You can also use [Piik online](#use-piik-online)
or [Piik App](#share-with-piik-app). Hosting a site yourself is an advanced option:
follow the [self-hosting guide](../operations/self-hosting.md) for server, HTTPS
and network setup.

1. Open your group's Piik site on your computer. Enter its site passphrase if asked.
2. Choose **Start sharing**. In the browser picker, select the screen, window or
   tab you want friends to see, and enable audio if offered.
3. Check the preview, then choose **Copy invite link** and send it to your friends.
4. Keep the sharing tab open. Use **Pause sharing**, **Switch source**, or
   **Stop sharing** when you need them.

Screen capture requires an HTTPS site or `localhost`. The sources and audio
offered by the picker depend on your browser and operating system.
Invitation links grant access to that room; share them with the people you want there.

## When something gets in the way

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
to reproduce it. [Diagnostics and export](../standards/configuration.md#diagnostics)
explains how to collect a local report and what to review before sharing it.

### When video will not connect

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

If these steps do not help, collect a [Debug report](../standards/configuration.md#diagnostics)
from the affected Viewer and, if possible, the Host for the same attempt. Include
the time, Piik version and network type when reporting the problem.

Ready to host a site for your group? Follow [self-hosting](../operations/self-hosting.md).
For everything else, use the [documentation map](../README.md).
