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

Hosts can turn off **Skip passwords** beside the link to copy the ordinary room
address. Visitors follow the site's and room's access checks; invite-only rooms
require the invitation credential. This switch does not revoke existing invites.

If an old link no longer works, ask the host for the current invitation.
App Local rooms and temporary public invitations end when that App run stops.

## Use Piik online

1. Open [demo.piik.tv](https://demo.piik.tv) in your browser.
2. Select **Start sharing**, then **Browser** for a screen, window or tab, or
   **Camera** where your computer or phone browser supports it. Enable source
   audio if the picker offers it.
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
4. Choose **Start sharing**, then select **Browser**, **Camera**, **Apps / Windows**, or
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

For Local room and Public invite, expand **Site passphrase** to set an optional
access passphrase.

For **Connect to Site**, enter the full site address, such as
`https://demo.piik.tv`, then choose **Open Piik**. Enter the site's passphrase
on the page that opens if asked.
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

1. Open your group's Piik site. Enter its site passphrase if asked.
2. Choose **Start sharing**, then **Browser** to select a screen, window or tab
   in the browser picker, or **Camera** where your computer or phone browser supports it.
   Enable source audio if the picker offers it.
3. Check the preview, then choose **Copy invite link** and send it to your friends.
4. Keep the sharing tab open. Use **Pause sharing**, **Switch source**, or
   **Stop sharing** when you need them.

Screen capture requires an HTTPS site or `localhost`. The sources and audio
offered by the picker depend on your browser and operating system.
Invitation links grant access to that room; share them with the people you want there.

To use App capture on that same site, follow [Connect to Site](#choose-an-app-mode).
The site manages rooms and invitations; the App supplies native capture.
If its operator has enabled SFU forwarding, turn off **Privacy mode** before
sharing to allow that fallback. The project's online site uses P2P only.

## Add your voice

While sharing, select **Microphone** below the picture and
allow microphone access. Select it again to mute. Open **Sharing settings** below the picture
to choose a microphone and adjust its input volume.
The default volume is 100%, with up to 200% available.
Source audio and your voice reach viewers together. The Host preview stays muted.

Camera sharing does not enable the microphone automatically. App **Apps / Windows**
and **Screens** capture use the same controls. Leave the device on **Default device**
or choose a specific microphone. In the **Camera** tab, allow access if asked,
then select a picture card to start sharing. Device names and previews depend on
browser permissions; while a camera is shared, other cameras are listed by name.
Use headphones to keep speaker sound from feeding back into the microphone.

## When something gets in the way

For sound, capture, startup or playback issues, see [Troubleshooting](./troubleshooting.md).

### When video will not connect

See [connection troubleshooting](./troubleshooting.md#when-video-will-not-connect)
for “No media route available” and similar connection failures.
