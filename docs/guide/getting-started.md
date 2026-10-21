# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Back to Piik](../../README.md)

Piik shares one person's screen with up to 20 invited viewers. This guide covers
watching, using Piik online, using Piik App and sharing through an existing site.

[Join a room](#join-a-friends-room) · [Use online](#use-piik-online) ·
[Piik App](#share-with-piik-app) · [Existing site](#share-from-an-existing-site) ·
[Room tools](./room-tools.md) · [Troubleshooting](./troubleshooting.md)

Viewers need a browser and an invitation. To start sharing, download Piik App
and choose **Public invite**. To share without installing, open
[Piik online](https://demo.piik.tv) and create a room in your browser.

## Join a friend's room

1. Open the invitation link your friend sent in a desktop or mobile browser.
2. Wait for their screen to appear. If the browser blocks autoplay, press **Play**.
3. Move the pointer over the picture or tap it to show the playback bar.

The playback bar controls only your own picture and sound.
Use the playback button to pause or resume; on a computer, double-click the picture to enter or
leave fullscreen where supported. On a phone, tap the picture to show the bar
and use its buttons. Safari may show system controls in video fullscreen.

See [playback controls](./sharing.md#playback-controls) for display and sound options.

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

If macOS blocks the first launch, follow the [Mac opening steps](./troubleshooting.md#macos-blocks-first-launch).

Click the launcher's update button to download the new App. **Gitee mirror**
provides an alternative if the download is slow or unavailable. A new major
version includes a compatibility warning that links to the upgrade instructions;
read them before replacing your App.

| Filename contains | Platform |
| --- | --- |
| `windows-amd64` | Windows x64 |
| `darwin-arm64` | Apple silicon; native capture requires macOS 13+ |
| `darwin-amd64` | Intel Mac; native capture requires macOS 13+ |
| `linux-amd64` | Linux x64 |
| `linux-arm64` | Linux ARM64 |

Windows App and browser sharing are the primary tested paths. Physical-device
coverage for the macOS and Linux apps is still limited;
[test results and feedback are welcome](https://github.com/TNTcraftHIM/Piik/issues).
Linux native capture also needs [system components](../../native/capture/linux/README.md).
See the [App guide](../../cmd/piik-app/README.md) for package and runtime details.

### Choose an App mode

| Mode | When to choose it | What to keep in mind |
| --- | --- | --- |
| **Local room** | Friends are on the same local network. | With multiple interfaces, expand **Local invitation address** and select the interface and IP on your friends' network. Your computer must be reachable from theirs. A local site passphrase is optional. |
| **Public invite** | Friends are elsewhere and you want a temporary invitation. | Needs Internet access. The public address lasts for this App run. |

For Local room and Public invite, expand **Site passphrase** to set an optional
access passphrase.
Local invitations use HTTPS. On first access, confirm the local certificate
against the Host's App terminal before continuing; see the
[certificate guide](./troubleshooting.md#local-https-certificate-warning).
Once the room service starts, click the connected **App** button at the top right
to return to the launcher, manage site access or reopen the room. The App terminal
also keeps an **App launcher** address. To change between Local room and Public
invite, close and reopen the App, then choose again. This ends the previous room
and generates a new public-invitation address.

### Use App with an existing site

1. Keep Piik App running and open the Piik site in your browser. Enter its site
   passphrase if asked; [Piik online](https://demo.piik.tv) needs no site passphrase.
   No room mode needs to be selected in the App launcher.
2. Click **App** at the top. Allow local-network access if the browser asks.
3. Check the site address on the local confirmation page, then choose **Allow access**.
4. Return to the site, choose **Start sharing**, then **Apps / Windows** or **Screens**.
   Select a source and send the new room invitation to your friends.

You can also choose **Connect Piik App** inside the **Start sharing** source
selector; its list updates as soon as the connection completes.
If connection fails, the App button offers **Retry** and **Download App**.
You can still share and watch in your browser.

The browser remembers the connection to an approved site. Reconnect after
changing browsers, using a private window or clearing site data. In the App
launcher, **×** revokes a site and **☆** makes it open next time; approving a
different site replaces the previous one. See the [App reference](../../cmd/piik-app/README.md#modes)
for these options and returning to the launcher. A new public-invite address needs
its own approval.

**A page that opens does not guarantee a video connection.** Public invite gives
your room a temporary web address; picture and sound still travel between
participants. This mode has no media-server fallback, and the temporary address
has no uptime guarantee. All modes need a working UDP media path.
The [App guide](../../cmd/piik-app/README.md#modes) explains the connection setup.

### Upgrading

**Piik 2.x and 1.x cannot be used together.** The App and the site it connects to
need the same major version. Different 2.x versions preserve established sharing
and viewing; new features require support from the relevant App and site.
Read the release notes on
[GitHub](https://github.com/TNTcraftHIM/Piik/releases/latest) or
[Gitee](https://gitee.com/TNTcraftHIM/Piik/releases) before upgrading.

- **Local room or Public invite:** stop sharing, close the old App and extract
  the complete new package. Start the new App and send a fresh invitation.
- **An existing site:** the administrator updates the Server first, following
  the [update guide](../operations/service-management.md). Then update the Apps
  connecting to that site and refresh all sharing and viewing pages.

Restarting an App or Server interrupts active shares.

## Share from an existing site

You need an existing HTTPS site running Piik Server, provided by a friend or
administrator. You can also use [Piik online](#use-piik-online)
or [Piik App](#share-with-piik-app). Hosting a site yourself is an advanced option:
follow the [self-hosting guide](../operations/self-hosting.md) for server, HTTPS
and network setup.

1. Open your group's Piik site. Enter its site passphrase if asked.
2. Choose **Start sharing**, then **Browser** to select a screen, window or tab,
   or **Camera** where your computer or phone browser supports it.
   Enable source audio if the picker offers it.
3. Check the preview, then choose **Copy invite link** and send it to your friends.
4. Keep the sharing tab open. Use **Pause sharing**, **Switch source**, or
   **Stop sharing** when you need them.

Screen capture requires an HTTPS site or `localhost`. The sources and audio
offered by the picker depend on your browser and operating system.
Invitation links grant access to that room; share them with the people you want there.

To use App capture on that same site, follow [Use App with an existing site](#use-app-with-an-existing-site).
The site manages rooms and invitations; the App supplies native capture.
If its operator has enabled SFU forwarding, turn off **Privacy mode** before
sharing to allow that fallback. The project's online site uses P2P only.

## Next steps

- [Sharing and playback](./sharing.md): picture settings, camera inputs and source sound.
- [Chat, voice and remote control](./room-tools.md): talk, react or let a friend take control.
- [Troubleshooting](./troubleshooting.md): start from the symptom you see.
