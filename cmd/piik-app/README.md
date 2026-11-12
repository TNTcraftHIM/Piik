# Piik App

This reference covers the 3.0 internal test App supplied to testers. Public
downloads and the online Demo still use 2.x; use the [2.6.0 App reference](https://github.com/TNTcraftHIM/Piik/blob/v2.6.0/cmd/piik-app/README.md) for those versions.

English · [简体中文](./README.zh-CN.md) · [Getting started](../../docs/guide/getting-started.md)

Piik App opens its controls in your browser. It can run your group's site,
host rooms while their pages are closed, and provide the picture and sound
capture available on your device.

## Run A Package

Use the matching platform package supplied for this test:

- **Windows:** extract the whole ZIP, keeping `web/` and `runtime/` beside
  `piik-app.exe`, then open that executable.
- **Android:** install the supplied APK, then open Piik. Keep App data when
  updating the same test channel. See [installation steps](../../docs/guide/getting-started.md#share-with-piik-app).
- **Linux/macOS, when supplied:** keep the complete package. Run `./piik-app`
  on Linux, or open `Piik App.app` on macOS. Platform requirements and device
  coverage are in the [Native reference](../../prototype/channel-native/README.md)
  and [verification status](../../docs/verification-status.md).

The launcher opens in the system browser. If it does not, open the **App launcher**
address printed in the terminal. Keep the App running while using its services.
For a blocked Mac build, follow the [Mac opening steps](../../docs/guide/troubleshooting.md#macos-blocks-first-launch).

## Modes

Choose **Local network** or **Public invite**, then **Open Piik**. This starts
one site containing your rooms. Anyone opening its address can create a room;
a private room needs its own invitation or password.

The launcher's mode preference stays in this browser. An App-owned startup
choice also saves the mode in App and starts it on the next run. Returning to
an already running site keeps its current mode. To choose another mode, first
clear **Open my site when App starts** if enabled, finish your activities, then
quit App normally and reopen the launcher.

### Local Network

Use this mode when friends can reach your device on the same LAN or
[virtual LAN](../../docs/guide/network.md#optional-a-virtual-lan).
If several addresses appear, choose one on the network your friends use.

Friends open the full HTTPS invitation on that address. On their first visit,
compare the [local certificate fingerprint](../../docs/guide/troubleshooting.md#local-https-certificate-warning)
with **Local connection details** below **Open Piik** in the launcher (or
**Certificate SHA-256** in a desktop terminal). Send friends the selected site
address or room link instead of a `localhost` address.

### Public Invite

The packaged Cloudflare helper provides a temporary HTTPS address. Send the
site address or room link from the opened Piik page. Keep App running: stopping
it ends access through that address. A later run may get a different address,
while the saved site and rooms remain the same.

Text, history and attachment descriptions use the domain connection. Pictures,
room voice and file content use peer connections separately. If chat works but a
transfer fails, use the [matching connection checks](../../docs/guide/troubleshooting.md#common-problems).

## Join Or Create A Room

To visit someone else's group, open their complete **3.0** invitation in a
browser. Starting your own App site creates a separate place; it does not
join or take over theirs.

To make a room, open your own or another **3.0** site and select
**Create room**. Read the form's hosting note:

- **Hosted by App:** the linked App saves the room and keeps it available after
  this page closes, while the App remains running.
- **Hosted by this page:** the browser saves the room; closing this page pauses
  hosting. Connecting App later does not move that room automatically.

People admitted to a room can chat, join voice, share and watch. See
[sharing controls](../../docs/guide/sharing.md) and [room tools](../../docs/guide/room-tools.md).

### Approved Site

To use App with an existing **3.0** site:

1. Keep App running. On that site's page, select **App → Open App page**.
2. On the local approval page, check the complete site address, then **Allow access**.
   Allow browser local-network access if asked.
3. Return to the site. Wait until App is ready before creating an App-hosted
   room or choosing an App capture source.

You can also use **Open a site** in the launcher to enter and approve an address.
Approval applies to that exact site address. Another address or browser may need
its own connection step. Room admission and remote-control consent remain separate.

In the approved-site list:

- Select a site to open it.
- Star an external site to open its fixed address when App starts. Starring
  the current App-owned site saves its Local network or Public invite mode;
  App starts that mode and opens its new ready address. The launcher names
  this choice **Open my site when App starts (mode)**. Clear it to return to
  the launcher on the next start; the current site keeps running.
- Remove approval to stop that site's App hosting and control connections.
  Saved rooms remain and other sites continue. Reapprove the same site and use
  the same domain account to reopen its rooms.

## Return To App Or Stop It

From a connected page, **App → Open App page** returns to the local controls.
On desktop, you can also reopen the launcher address in the terminal; on Android,
open Piik or its running notification. Returning to the launcher keeps the domain running.

Closing a page stops its personal voice, shares, watches and control permission.
App-hosted rooms continue; Browser-hosted rooms need their hosting page.
Switching rooms within a page keeps its other activities running.

To stop App, use **Ctrl+C** in its terminal. On macOS, the App's **Quit** action
requests normal shutdown; on Android, use the running notification's stop action.
This ends App hosting, captures and the temporary public entry. Saved rooms and
confirmed history remain for the next start. Do not delete data to close a room.

## Data And Backups

App saves domain identity, approved sites and hosted room databases in its
application-data directory. Its local site keeps the same address across restarts,
preserving the browser's file cache and preferences. A changed public invitation
address does not create new copies of the App's rooms. Browser-hosted rooms instead
use that browser's site storage; clearing it can delete their data.

Use the room's **Settings → Records** for a room backup when you manage
the room. A text export keeps the loaded messages for reading; it is not a
restorable room backup. The site operator uses **Site settings → Backup** to save
site identity and directory metadata at the hosting service; this does not export
other users' room histories. Room histories need their room backups separately. Attachment file
copies are separate from their history descriptions.

Keep backups private. Back up needed data before changing installation channels,
moving data or uninstalling. Do not clear App/browser storage to repair a
connection. The [saved-data reference](../../prototype/channel-server/README.md#saved-data-and-files)
explains backup scope and restore behavior.

## Upgrading

Use the next matching package supplied for this 3.0 test, including its Web UI.
A public 2.x release is not an update for the test App. When versions are
incompatible, update the domain's Server and connected Apps together, then refresh its pages.

1. Save needed backups, finish transfers and stop personal activities.
2. Stop App normally. Extract the full desktop update into a new directory,
   or install the matching Android update over the existing test App.
3. Start with the same application-data directory. Send the current invitation
   if its address changed.

If App reports `unsupported_storage_version` or `unsupported_domain_checkpoint`,
preserve the old data and follow the [storage-format checks](../../docs/guide/troubleshooting.md#the-beta-app-reports-unsupportedstorageversion)
and the instructions supplied with that test package.

The launcher checks published releases and links to their notes. During this
unpublished test, follow the supplied test-update instructions rather than
switching to a different public channel.

## Troubleshooting

Start with [the symptom index](../../docs/guide/troubleshooting.md#common-problems).
Chat/history needs the domain connection and actual room host. Picture, voice
and file content also need their peer connections.

### Chromium WebRTC Connections

When chat works but peer transfers do not, compare
[browser WebRTC settings](../../docs/guide/network.md#browser-webrtc-restrictions).
For a codec-specific failure, use the [Windows H264 checks](../../docs/guide/troubleshooting.md#h264-sharing-fails-on-windows).

### Diagnostics

On the local launcher, open **Help → Debug**, reproduce the problem, then
select **Help → App report**. On a narrow screen, these entries are under **More options**.
This saves a local ZIP. Restarting App ends
that process's diagnostic collection.

For a browser report, open **Help → Debug**, confirm the reload, reproduce once,
then use **Help → Web report**. Check private information before sharing reports
from the same attempt; see [reporting steps](../../docs/guide/troubleshooting.md#reporting-a-problem).

## Configuration And Developer Reference

Normal use starts with the launcher. Isolated data, a specific loopback port and
source development use the [current Rust App settings](../../prototype/channel-server/README.md#local-app-link).
The [Native reference](../../prototype/channel-native/README.md) owns capture,
encoding and input requirements; [Android runtime](../../mobile/README.md) owns
the shell. [App development](./DEVELOPMENT.md) covers source builds and packaging.
