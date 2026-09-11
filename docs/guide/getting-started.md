# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Back to Piik](../../README.md)

Bring a game, a work in progress, or a new discovery. One person shares; up to 20 friends
watch in their browsers.

[Join a room](#join-a-friends-room) · [Share in a browser](#share-from-your-browser) ·
[Set up Piik App](#share-with-piik-app) · [Fix a problem](#when-something-gets-in-the-way)

Download the package for your system from
[GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases), use your group's
Piik site, or [run from source](../README.md#run-from-source).

Piik opens in illustrated mode. Choose **EN** in the header to show the labels
used below. **中** switches to Chinese; **✦** returns to the illustrations.

## Join a friend's room

1. Open the invitation link your friend sent in a desktop or mobile browser.
2. Wait for their screen to appear. If the browser blocks autoplay, press **Play**.
3. Move the pointer over the picture or tap it to show the playback bar.

The playback bar controls only your own picture and sound.

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

## Share from your browser

1. Open your group's Piik site on your computer. Enter its site passphrase if asked.
2. Choose **Start sharing**. In the browser picker, select the screen, window or
   tab you want friends to see, and enable audio if offered.
3. Check the preview, then choose **Copy invite link** and send it to your friends.
4. Keep the sharing tab open. Use **Pause sharing**, **Switch source**, or
   **Stop sharing** when you need them.

Screen capture requires an HTTPS site or `localhost`. The sources and audio
offered by the picker depend on your browser and operating system.
Invitation links grant access to that room; share them with the people you want there.

## Share with Piik App

1. Extract the whole package for your platform and keep its directory structure intact.
2. Open `piik-app.exe` on Windows, `Piik App.app` on macOS, or `./piik-app` on Linux.
   The launcher opens in your system browser.
3. Choose a mode below, then select **Open Piik**.
4. Choose **Start sharing**, then select **Browser**, **Apps / Windows**, or
   **Screens** as available. Pick the actual source and sound option.
5. Copy and send the room invitation. Keep both the App and sharing tab open.

Windows App and browser sharing are the current focus. macOS/Linux native
capture still needs physical validation; Linux also needs
[system capture components](../../native/capture/linux/README.md).
See the [App guide](../../cmd/piik-app/README.md) for package and runtime details.

### Choose an App mode

| Mode | When to choose it | What to keep in mind |
| --- | --- | --- |
| **Local room** | Friends are on the same local network. | Your computer must be reachable from theirs. A local site passphrase is optional. |
| **Public invite** | Friends are elsewhere and you want a temporary invitation. | Needs Internet access. The public address lasts for this App run. |
| **Connect to Site** | Your group already has a Piik site. | Enter its address; the App adds capture capabilities to the site's sharing page. |

**A page that opens does not guarantee a video connection.** Public invite gives
your room a temporary web address; picture and sound still travel between
participants. This mode has no media-server fallback, and the temporary address
has no uptime guarantee. All modes need a working UDP media path.
The [App guide](../../cmd/piik-app/README.md#modes) explains the connection setup.

## When something gets in the way

| What you see | Try this |
| --- | --- |
| Picture but no sound | Unmute the video. The host should choose a source with shareable audio; if sound was disabled, stop and start sharing with it enabled. App window/screen capture keeps that setting when switching sources. |
| No screen picker | Allow the browser or App to record the screen when the OS asks. Browser capture needs HTTPS or `localhost`; try sharing from a desktop computer. |
| Local invitation will not open | Check that both devices are on the same network and can reach each other. Guest Wi-Fi or firewall rules can block local access. |
| Page opens but video will not connect | Choose **Reconnect** in the playback bar. If it still fails, check [WebRTC connection settings](../../cmd/piik-app/README.md#chromium-webrtc-connections) or try a site with media fallback. |
| Sharing stops after sleep or suspension | Wake the device and return to the sharing tab; start sharing again if needed. Browser and OS suspension can interrupt capture or playback. |

For a bug report, include the version, OS/browser, what you expected, and how
to reproduce it. [Diagnostics and export](../reference/configuration.md#diagnostics)
explains how to collect a local report and what to review before sharing it.

Ready to host a site for your group? Follow [self-hosting](../operations/self-hosting.md).
For everything else, use the [documentation map](../README.md).
