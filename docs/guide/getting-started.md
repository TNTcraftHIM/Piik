# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Back to Piik](../../README.md)

Bring a game, a screen, and a few friends. One person shares; up to 20 friends
watch in their browsers.

Public App downloads and a demo site are not available yet. Use your group's
Piik site or App package, or [run from source](../README.md#run-from-source).

Piik opens in illustrated mode. Choose **EN** in the header to show the labels
used below. **中** switches to Chinese; **✦** returns to the illustrations.

## Watch a friend

1. Open the invitation link your friend sent in a desktop or mobile browser.
2. Wait for their screen to appear. If the browser blocks autoplay, press **Play**.
3. Use the video's controls for sound and fullscreen. These controls affect only your view.

With just a four-digit room code, open the same Piik site and choose
**Join a room**. You may need the site's passphrase and the room's password.
A room set to invitation-only needs its invitation link.

If an old link no longer works, ask the host for the current invitation.
App Local rooms and temporary public invitations end when that App run stops.

## Share from your browser

1. Open your group's Piik site on your computer. Enter its site passphrase if asked.
2. Choose **Start sharing**. In the browser picker, select the screen, window or
   tab you want friends to see, and enable audio if offered.
3. Check the preview, then copy the room's invitation link and send it to your friends.
4. Keep the sharing tab open. Use **Pause sharing**, **Switch source**, or
   **Stop sharing** when you need them.

Screen capture requires an HTTPS site or `localhost`. The sources and audio
offered by the picker depend on your browser and operating system.
Invitation links grant access to that room; share them with the people you want there.

## Share with Piik App

1. Extract the whole package for your platform. Keep the `runtime` folder beside
   the executable; it contains the App's capture and public-link helpers.
2. Open `piik-app.exe` on Windows, `Piik App.app` on macOS, or `./piik-app` on Linux.
   The launcher opens in your system browser.
3. Choose a mode below, then select **Open Piik**.
4. Choose **Start sharing**, then select **Browser**, **Apps / Windows**, or
   **Screens** as available. Pick the actual source and sound option.
5. Copy and send the room invitation. Keep both the App and sharing tab open.

Packaged use needs no Node.js, npm or Go. Linux native capture also needs
[system capture components](../../native/capture/linux/README.md).
Windows App and Browser are the current acceptance focus; macOS/Linux native
capture still needs physical validation. See [platform status](../status.md).

### Choose an App mode

| Mode | When to choose it | What to keep in mind |
| --- | --- | --- |
| **Local room** | Friends are on the same local network. | Your computer must be reachable from theirs. A local site password is optional. |
| **Public invite** | Friends are elsewhere and you want a temporary invitation. | Needs Internet access. The public address lasts for this App run. |
| **Connect to Site** | Your group already has a Piik site. | Enter its address; the App adds capture capabilities to the site's sharing page. |

Public invite uses Cloudflare Quick Tunnel for the room's web connection.
The media itself uses peer connections, with no server media fallback in this mode,
and the tunnel has no uptime guarantee. If this mode cannot connect on your network,
a Piik site with media fallback enabled may help. All modes need a working UDP
media path.

For runtime options and package details, see the [App guide](../../cmd/piik-app/README.md).

## When something gets in the way

| What you see | Try this |
| --- | --- |
| Picture but no sound | Unmute the viewer's video. The host should check the source's audio option and use **Switch source** to select it again if needed. Some sources have no shareable audio. |
| No screen picker | Allow the browser or App to record the screen when the OS asks. Browser capture needs HTTPS or `localhost`; try sharing from a desktop computer. |
| Local invitation will not open | Check that both devices are on the same network and can reach each other. Guest Wi-Fi or firewall rules can block local access. |
| Page opens but video will not connect | Use the viewer's reconnect control. Check [WebRTC connection settings](../../cmd/piik-app/README.md#chromium-webrtc-connections) if the failure persists; page access alone does not prove media can connect. |
| Sharing stops after sleep or suspension | Wake the device and return to the sharing tab; start sharing again if needed. Browser and OS suspension can interrupt capture or playback. |

For a bug report, include the version, OS/browser, what you expected, and how
to reproduce it. [Diagnostics and export](../reference/configuration.md#diagnostics)
explains how to collect a local report and what to review before sharing it.

Ready to host a site for your group? Follow [self-hosting](../operations/self-hosting.md).
For everything else, use the [documentation map](../README.md).
