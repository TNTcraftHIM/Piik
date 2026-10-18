# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Back to Piik](../../README.md)

Piik shares one person's screen with up to 20 invited viewers. This guide covers
watching, using Piik online, using Piik App and sharing through an existing site.

[Join a room](#join-a-friends-room) · [Use online](#use-piik-online) ·
[Piik App](#share-with-piik-app) · [Existing site](#share-from-an-existing-site) ·
[Chat and reactions](#chat-and-reactions) ·
[Troubleshooting](#when-something-gets-in-the-way)

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

<details>
<summary>Playback controls, at a glance</summary>

| Control | What it does |
| --- | --- |
| **Theater mode** | Expands the picture inside the browser tab. |
| **Fullscreen** | Expands the picture to the full screen. |
| **Picture in picture** | Opens a floating video where supported. |
| **Volume** | Goes up to 200% with audio boost, or 100% otherwise. Lower it if the sound distorts. |
| **Playback settings** | **Fit** keeps the whole picture visible; **Fill** crops its edges; **Stretch** fills the area by changing its proportions. Connection settings default to **Auto**; available alternatives depend on the host and site. |

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

When the launcher offers an update, **Release notes** opens its details on GitHub
or Gitee. A new major version includes a compatibility warning; read the upgrade
instructions before replacing your App.

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

The same browser remembers this connection. On later visits, **Start sharing**
offers **Apps / Windows** and **Screens** from the running App. In another browser,
in a private window or after clearing site data, connect again. The same exact
site already approved by App needs no repeat confirmation. The launcher
shows the approved site; **×** beside its address revokes access. Approving a different site
replaces the previous one and ends that site's App connections.
Select **☆** beside the address to open that site automatically next time you
start the App. Turn it off to return to the launcher on startup. The connected
**App** button on the site opens the launcher for these settings.
If the site is unavailable, use the **App launcher** address in the App terminal.
To use your App with a friend's new public-invitation address, connect and approve
that address again. Sharing-quality settings saved in App survive the address change.

**A page that opens does not guarantee a video connection.** Public invite gives
your room a temporary web address; picture and sound still travel between
participants. This mode has no media-server fallback, and the temporary address
has no uptime guarantee. All modes need a working UDP media path.
The [App guide](../../cmd/piik-app/README.md#modes) explains the connection setup.

### Upgrading

**Piik 2.0 and 1.x cannot be used together.** The App and the site it connects to
need the same major version. Read the release notes on
[GitHub](https://github.com/TNTcraftHIM/Piik/releases/latest) or
[Gitee](https://gitee.com/TNTcraftHIM/Piik/releases) before upgrading.

- **Local room or Public invite:** stop sharing, close the old App and extract
  the complete new package. Start the new App and send a fresh invitation.
- **An existing site:** the administrator updates the Server first, following
  the [update guide](../operations/service-management.md). Then update the Apps
  connecting to that site and refresh all sharing and viewing pages.

Restarting an App or Server interrupts active shares. This upgrade does not
change the room database schema.

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

## Picture and sound settings

Open **Sharing settings** below the picture. Picture presets are directly available;
expand **Fine-tune picture** for resolution, frame-rate, bitrate, picture preference and video codec.

- In **Fine-tune picture**, enter width and height under **Resolution limit**.
  Piik preserves the source's proportions within that ceiling, including portrait
  and ultrawide pictures.
- Sliders cover 15–60 fps in steps of 5 and 2–12 Mbps in steps of 0.5. You can also enter an
  **FPS limit** from 1 to 240 fps and a **Bitrate limit** from 0.1 to 240 Mbps.
  Values outside those slider steps show **Custom**; **Use common range**
  selects the nearest available slider value.
  The frame-rate limit depends
  on picture size: for example, 1080p240, 1440p144 and 4K60 are accepted requests.
- Under **Sound**, adjust source audio and microphone input. **Audio quality**
  controls the shared audio output: choose a preset or enter an **Audio bitrate limit**
  from 6 to 320 kbps.

The selectable range depends on picture size and the connected App. Picture and sound
still adapt to the source, device and available bandwidth.

Piik remembers your applied settings for the next visit. Browser-only use remembers
them for the current site; opening Piik through an updated App also keeps them
when your public-invite address changes.

## Add your voice

While sharing, select **Microphone** below the picture and
allow microphone access. Select it again to mute. Open **Sharing settings → Sound** below the picture
to choose a microphone and adjust its input volume.
The default volume is 100%, with up to 200% available.
Source audio and your voice reach viewers together. The Host preview stays muted.

Camera sharing does not enable the microphone automatically. App **Apps / Windows**
and **Screens** capture use the same controls. Leave the device on **Default device**
or choose a specific microphone. In the **Camera** tab, allow access if asked,
then select a picture card to start sharing. Device names and previews depend on
browser permissions; while a camera is shared, other cameras are listed by name.
Use headphones to keep speaker sound from feeding back into the microphone.

With **Browser** or **Camera** capture, **Noise & echo reduction** in sound
settings is on by default, asking the browser to handle echo, noise and volume.
Turn it off for music or a virtual audio input. Device and system effects remain
controlled by their own settings. App native capture uses device/system audio settings.

A camera with a built-in microphone still needs separate video and audio input
selection. OBS Virtual Camera supplies video only. To include OBS audio, follow
the [OBS audio-routing guide](https://obsproject.com/kb/video-call-streaming-tutorial/),
then select the virtual audio input in Piik's microphone list and turn on the microphone.

### Exclude a voice app from screen audio

On Windows, this control applies to system sound from **Screens**. **Apps / Windows**
captures only the selected application's process tree; **Camera** uses the separately
selected microphone or audio input.

On supported Windows Apps, open the **Screens** tab and enable **System sound**.
Under **Exclude application audio**, select a window belonging to the voice app,
then choose the screen to share. Open the app's window and refresh if it is absent.
This excludes one process and its children. Other apps remain audible, including
those playing through other output devices.
It does not mute your Piik microphone or prevent speaker sound reaching a microphone.

If a virtual microphone remains audible with Piik's microphone off, temporarily
turn off **System sound** to compare. If the voice disappears, check the mixer's
playback output and monitoring, or capture only the desired application's window
audio. Excluding a voice app does not also exclude a separate mixer that plays
your processed voice, even through a virtual output device.

While sharing, use **Sharing settings → Sound** to change system sound or the
excluded app without stopping the share. If the app closes or restarts, source
audio stops; refresh the application list and select it again.
Turning source audio off retains the exclusion choice;
select **None** to restore unfiltered system audio. This control requires an updated page and a Windows App
whose capability probe supports process exclusion; it is not a Browser-capture filter.
Windows 10 support depends on system updates and the actual capability check.
If the option is absent, share a single application window or route the voice
app to a different playback device.

## Chat and reactions

Once the host starts the first share, participants can select **Interact** below the
sofa to send messages. Select a person on the sofa to open their reaction menu:
your own reactions appear above you; reactions sent to a friend fly towards them.
The interaction window can be moved and resized without rearranging the page.

Supported desktop browsers show **Open in always-on-top window** in its top-right
corner. You can read messages, see reactions and select someone to interact with
while playing. Keep the Piik page open; closing the small window returns it to the page.
Use a windowed or borderless game; exclusive fullscreen may cover the window.
The window cannot show the game through its background or let mouse clicks pass through.

**On screen**, beside the message box or in the viewer's playback bar, shows new
messages over the picture. It is off by default and only changes your own view.
Adjust text size and opacity in **Playback settings → On-screen chat**, or in
the chat window's **Chat settings**. Both use the same local preferences.
System video fullscreen and picture in picture cannot show these overlays.

Stopping a share keeps the room's chat available. App Local and Public invite
rooms require the App to stay open. Each page retains only its latest received
messages: refreshing clears them, and late joiners receive no earlier history.
To keep a copy, use **Chat settings → Export chat** to save the latest messages
retained on this page (up to 1,000) as a text file.
Chat travels through the room's server and is **not end-to-end encrypted**.

## When something gets in the way

For sound, capture, startup or playback issues, see [Troubleshooting](./troubleshooting.md).

### When video will not connect

See [connection troubleshooting](./troubleshooting.md#when-video-will-not-connect)
for “No media route available” and similar connection failures.
