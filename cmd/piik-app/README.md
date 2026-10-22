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

Windows App and browser sharing are the primary tested paths. Physical-device
coverage for the macOS and Linux apps is still limited; test results and
[feedback](https://github.com/TNTcraftHIM/Piik/issues) are welcome. macOS native
capture requires macOS 13 or newer on Apple silicon or Intel.

## Modes

- With no mode argument, the App opens its launcher and waits for use by an
  approved Site. Choose **Local room** or **Public invite** to start a room
  service on this device and enter the normal Host page.
  Star an approved Site in the launcher to open it on startup instead;
  turn the star off to restore the launcher. Revoking that Site also clears its star.
- The launcher remembers the last mode confirmed with **Open Piik**. Without a
  saved Local/Public choice, it selects Public invite and waits for confirmation.
- The default launcher checks official releases after it opens, using GitHub
  first and Gitee if GitHub is unavailable. Click the update button to download
  the matching platform ZIP, or open the release page when no package matches.
  **Release notes** opens separately; a new major version includes an upgrade
  warning. The App does not install or replace itself.

### Local Room

Choose **Local room** for a reachable LAN. Rooms last for this App run.

For Local invitations, the App automatically selects a sole active address or
sole private IPv4. If several addresses remain possible, choose an interface
and IP in the launcher. Public invite and use through a Site need no LAN selection.
The selected address is checked again at startup;
it selects the Local HTTPS entry and invitation address, while ICE selects media paths independently.
Local invitations use HTTPS on that address; the Host keeps its HTTP loopback
page. First access requires [confirming the local certificate](../../docs/guide/troubleshooting.md#local-https-certificate-warning)
against the App terminal. The certificate stays in memory and changes on restart.

### Public Invite

For one-link Internet sharing, open the App launcher, choose **Public invite**,
create a room in the opened Browser, and send its normal invitation link. The
random `trycloudflare.com` origin lasts only for that App run; a later launch
creates a new temporary link. Cloudflare Quick Tunnels provide no uptime guarantee;
use a configured Site when persistent control availability or SFU fallback matters.

Public invite uses the packaged Cloudflare Tunnel helper to expose the same
room service at a temporary HTTPS address. Picture and sound travel between
participants (P2P), outside the tunnel. Local and Public invite both need a usable
UDP media path and provide no media-server forwarding (SFU) or TURN relay fallback.
The [routing reference](../../docs/standards/routing-transport.md) explains connection setup.

Public invite uses Cloudflare, MiWiFi (Xiaomi) and Bilibili STUN services to
discover reachable addresses. Each contacted operator can see your public IP,
port and request timing; these requests contain no shared media, chat or room
password. NAT enhancement uses the same destinations automatically.
To choose your own STUN services for public invitations, set `PIIK_STUN_URLS`
before starting App; see [App configuration](../../docs/standards/configuration.md#piik-app-configuration).
An approved Site supplies its own `STUN_URLS`; App Local rooms configure no public STUN.

### Approved Site

To use a Piik Site, keep the App running and click **App** at the top of the Site.
Confirm its address on the local approval page. The App remembers each approved
Site, which the launcher can open or revoke independently. Revoking a Site ends
only its App connections; other approved Sites and Local rooms remain independent.
Click the connected **App** button on a Site to reopen the launcher. If the Site
will not open, use the **App launcher** address in the App terminal instead.
The browser remembers activation, so later visits reuse the running App with
that Site's rooms and any enabled SFU fallback. Browser capture remains available
without the App; see the
[connection steps](../../docs/guide/getting-started.md#use-app-with-an-existing-site).

## Capture

The Host page offers Browser and Camera capture alongside available native
windows or screens; select the source explicitly. Windows native capture offers VP8/Auto/H264;
Auto chooses one codec for the share. macOS and Linux native capture require
hardware H264. Source and audio support vary by platform; their setup is covered
in the [Windows](../../native/capture/windows/README.md),
[macOS](../../native/capture/darwin/README.md) and
[Linux](../../native/capture/linux/README.md) capture guides.
Native capture uses the Host's current quality settings. The
[media-quality reference](../../docs/standards/media-quality.md) owns codec selection,
live changes and encoding reuse; [verification status](../../docs/verification-status.md)
keeps the measured limits.

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

**Why can the page open, or screen capture succeed, while sharing or viewing fails?**

Browser settings, extensions or managed policies can block WebRTC UDP, including
the local Browser-to-App media connection. Follow the documentation center's
[browser WebRTC checks](../../docs/guide/troubleshooting.md#browser-webrtc-restrictions).
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
