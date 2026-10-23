# Piik App

English · [简体中文](./README.zh-CN.md) · [Getting started](../../docs/guide/getting-started.md)

Piik App provides local rooms and native screen capture through the Piik web
interface in your system Browser.

## Run A Package

Extract the matching platform bundle in full. On Windows and Linux, keep
`runtime` beside the App executable and run `piik-app.exe` or `./piik-app`.
On macOS, open `Piik App.app`; you can move the whole `.app` to Applications.
The launcher opens in the system Browser.
If macOS blocks the first launch, follow the [Mac opening steps](../../docs/guide/troubleshooting.md#macos-blocks-first-launch).
Linux native capture uses the system dependencies described
in the [Linux capture guide](../../native/capture/linux/README.md).

If the page does not open automatically, open the address shown in the terminal
or press **O** there to retry. Keep the App running while using that page.

macOS native capture requires macOS 13 or newer. Windows App and browser sharing
are the primary tested paths; [macOS/Linux feedback is welcome](https://github.com/TNTcraftHIM/Piik/issues).

## Modes

Choose **Local room** or **Public invite**, then **Open Piik**, to start a room
service. To supply capture to an existing site, leave the launcher open and
[approve that site](#approved-site).

App remembers the last confirmed room mode. On first use, **Public invite** is
selected and waits for confirmation. A starred site opens on startup instead.

The launcher checks releases through GitHub, with Gitee as an alternative.
Its update button downloads your platform's ZIP, or opens Releases if no package
matches. **Release notes** opens the changes; major upgrades show a warning.
Follow the [upgrade steps](#upgrading) to replace App.

### Local Room

Choose **Local room** for a reachable LAN. Rooms last for this App run.

App selects a sole active address or sole private IPv4 automatically. When
several are available, choose **Local invitation address** in the launcher.
For a [virtual LAN](../../docs/guide/network.md#optional-a-virtual-lan), choose its virtual IPv4.

Friends use the HTTPS invitation on that address; the Host uses the local
loopback page. On first access, friends must [confirm the certificate](../../docs/guide/troubleshooting.md#local-https-certificate-warning)
against the App terminal. Repeat confirmation after App restarts.

### Public Invite

Choose **Public invite**, create a room in the opened browser, and send its invitation.
The packaged Cloudflare Tunnel helper supplies a temporary `trycloudflare.com`
HTTPS address. It expires when App closes; a later run gets a new address.
For a permanent address, use a configured Piik site.

Local and Public invite use P2P picture and sound, outside the web tunnel.
They need a usable UDP media path and provide no server media forwarding (SFU)
or TURN relay. If the tunnel or media fails, use the [network checks](../../docs/guide/network.md)
and [public-invitation checks](../../docs/guide/troubleshooting.md#public-invitation-fails-or-shows-1033).

Public invite uses Cloudflare, MiWiFi (Xiaomi) and Bilibili STUN services to
discover reachable addresses. Each contacted operator can see your public IP,
port and request timing; these requests contain no media, chat or room password.
To choose your own STUN services for public invitations, set `PIIK_STUN_URLS`
before starting App; see [App configuration](../../docs/standards/configuration.md#piik-app-configuration).
An approved Site supplies its own `STUN_URLS`; App Local rooms configure no public STUN.

### Approved Site

Keep App running, click **App** at the top of the Piik site, and confirm its
address on the local approval page. See the [connection steps](../../docs/guide/getting-started.md#use-app-with-an-existing-site).

The launcher lists approved sites:

- Click a site to open it. **×** revokes its App connections while other sites and Local rooms continue.
- **☆** selects one site to open on startup. Clear the star to restore the launcher;
  revoking the starred site also clears it. Approving another site keeps existing approvals.
- Click a connected site's **App** button to reopen the launcher, or use the
  **App launcher** address in the terminal.

The browser remembers activation. Reconnect after changing browsers, using a
private window or clearing site data. A new public-invite address needs its own
approval. The site continues to own its rooms and enabled SFU forwarding.

## Capture

The Host page offers Browser and Camera capture alongside available native
windows or screens; select the source explicitly. Windows native capture offers VP8/Auto/H264;
Auto chooses one codec for the share. macOS and Linux native capture require
hardware H264. Source and audio support vary by platform; their setup is covered
in the [Windows](../../native/capture/windows/README.md),
[macOS](../../native/capture/darwin/README.md) and
[Linux](../../native/capture/linux/README.md) capture guides.
Adjust native capture through [Sharing settings](../../docs/guide/sharing.md#picture-and-sound-settings).

When the Windows App's capture runtime supports it, the **Apps / Windows** and
**Screens** tabs offer **Show capture border**, off by default. Change it when selecting or switching a
source; the Host page remembers your choice. Windows 10, system policy or another
active capture can keep the yellow border visible; sharing remains available.
See [capture-border troubleshooting](../../docs/guide/troubleshooting.md#yellow-capture-border-on-windows)
for an optional Windows 10 workaround.

## Configuration And Command Line

The App configuration keeps an optional Local site passphrase. Leave it
blank for an open Local site, or enter a password in the launcher before
starting. Viewer invitations grant access to their room independently; see
[rooms and access](../../docs/standards/rooms-access.md).

For saved preferences, configuration paths and environment variables, see
[App configuration](../../docs/standards/configuration.md#piik-app-configuration).
To bypass the launcher in development or automation, select a mode explicitly:

| Flag | Mode |
| --- | --- |
| `--local` | Local room; add `--lan-address <address>` when several LAN addresses are possible |
| `--link` | Temporary Public invite |
| `--site <origin>` | Save and open a Piik Site |

## Upgrading

App and site must use the same major version; **2.x and 1.x cannot be used together**.
Different 2.x versions preserve established sharing and viewing. New features
require support from the relevant App and site.

1. Read the release notes on [GitHub](https://github.com/TNTcraftHIM/Piik/releases/latest)
   or [Gitee](https://gitee.com/TNTcraftHIM/Piik/releases).
2. For Local room or Public invite, stop sharing, close App and extract the
   complete new package. Start it and send a fresh invitation.
3. For a group's site, the administrator [updates Server](../../docs/operations/service-management.md)
   first. Then update connected Apps and refresh all sharing/viewing pages.

The launcher update button downloads the package; **Gitee mirror** is an
alternative source. Restarting App or Server interrupts active shares.

## Terminal And Shutdown

The terminal shows the current mode, entry links and startup state; its language
follows the launcher and App-enabled pages.
Press `o` to reopen the Browser, or `q` / Ctrl+C to end Local
rooms and stop the local server and temporary public link. Plain-text output
uses Ctrl+C. The Linux desktop entry also opens this terminal. The App keeps
running after a Site tab closes.
When launched in its own Windows console, a startup or runtime error leaves the
error visible until Enter is pressed. Normal shutdown, existing terminals and
redirected or automated runs exit directly.

## Troubleshooting

### Chromium WebRTC Connections

Browser settings, extensions or managed policies can block WebRTC UDP, including
the local Browser-to-App media connection. Follow the documentation center's
[browser WebRTC checks](../../docs/guide/network.md#browser-webrtc-restrictions).
For codec-specific failures, see [Windows H264 troubleshooting](../../docs/guide/troubleshooting.md#h264-sharing-fails-on-windows).

### Diagnostics

Enable **Debug launch** in the launcher before starting a room or connecting a Site, reproduce the
problem, then press `D` in the interactive terminal to export a local ZIP.
Use `--debug` for failures before the selector opens. Exporting does not stop
the share or upload the archive. For Browser diagnostics, open **Help → Debug**
after the theme control, confirm the reload, then use **Help → Web report** to download.
For cooperation failures, include both reports from the same reproduction. The
[diagnostic reference](../../docs/standards/configuration.md#diagnostics) owns
log locations, export commands, retention and privacy boundaries.

## For Developers

[App development](./DEVELOPMENT.md) covers source builds, packaging, desktop icons
and validation gates. [Deployment](../../docs/deployment.md) covers maintained
release publication.
