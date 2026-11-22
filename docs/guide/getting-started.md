# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Documentation](./README.md)

This guide is for the **3.0 test App and 3.0 links** supplied to testers.
The public online site and published downloads still belong to 2.x; use the
[stable documentation](https://piik.tv/docs/?lang=en)
for those versions.

| You have… | Start here |
| --- | --- |
| A friend's 3.0 link | [Join their room](#join-a-friends-room). A browser is enough to watch. |
| A 3.0 test App package | [Create a room with App](#share-with-piik-app). |
| Your group's 3.0 site address | [Join a room on that site](#share-from-an-existing-site). |

A **site** can have several rooms. The site owner decides who can create them and can require members’ rooms to be invitation-only. Once in a room, you can chat, join voice, share your screen or watch a friend.

## Join a friend's room

1. Open the complete 3.0 link in a computer or phone browser. The site opens
   directly and remembers your identity in this browser.
2. Choose a room from the room list. On a narrow screen, **Rooms** opens that
   list. A private room may need its own invitation or **room password**.
3. In the room's available screens, choose the person whose picture you want
   and select **Watch**. If playback is blocked, press **Play**.
4. Write in the message box to chat. Select **Join voice** in the personal area
   and allow microphone access. Mute your microphone whenever you only want to listen.

Several people can share at once. You choose which pictures to watch; playback
volume and local pause affect only your own viewing. Move the pointer over the
picture, tap it or focus a playback button to reveal its controls.

You do not need to launch your own App or create another room to watch a friend.
Keep the full invitation link your friend sent. Opening your own App launcher takes you to your own site.

## Use a 3.0 link without installing

Open a friend's 3.0 link or a 3.0 site supplied by your group, then follow
[joining a room](#join-a-friends-room). You can also share from the browser
where screen or camera capture is supported. `demo.piik.tv` is the public 2.x
site, not the entry for this test version.

## Share with Piik App

1. Use the **3.0 test package you received**. On Windows, extract the whole
   archive and open `piik-app.exe`; on Android, install the supplied APK and
   open Piik. Keep the desktop package's files together.
2. On Windows the launcher opens in the Piik window by default. You can also use the system browser.
   Choose a mode below and select **Open Piik**. Your first visit opens the room overview. Select the Piik mark to return to it later.
3. If the site lets you create rooms, select **Create your first room** on an empty site. You can rename **Living room**. If the form offers a choice, select **Public** or **Private**. Check the hosting note,
   then select **Create room** to enter it. Later, use **Create room** in the
   room list (**Rooms** on a narrow screen) to open the same form.
4. [Invite your friends](#invite-friends), then select **Start sharing**.
   Choose **Browser**, **Camera**, or an available App window/screen source.
   Select the actual source and enable source sound if offered.
5. Your friends enter the room and select **Watch** on your picture.
   Each person joins voice separately; picture sharing does not start a call.

### Choose an App mode

- **Local network:** for friends on the same LAN or virtual LAN. If several
  invitation addresses are offered, choose the interface they can reach.
- **Public invite:** for friends elsewhere. **Automatic** creates a temporary
  Cloudflare address while App is running; send a new link if it changes.
  **Existing address** uses [your own HTTPS proxy](#use-an-existing-public-address).

Local invitations use HTTPS. After starting **Local network**, return to the
App launcher and expand **Local connection details** below **Open Piik** to
read the address and certificate fingerprint. Compare it with the browser's
certificate before accepting its first warning; see the
[certificate steps](./troubleshooting.md#local-https-certificate-warning).

### Use an existing public address

If you already operate frp or another HTTPS reverse proxy:

1. Before starting the site, select **Public invite → Existing address**. Enter
   your HTTPS site address without a path, query or invitation fragment.
2. Forward its HTTP and WebSocket traffic to the displayed **Local forwarding
   target**, initially `http://127.0.0.1:8787`. Run frpc on the same computer as
   App; do not forward the separate App management/discovery port.
3. Configure the domain and trusted certificate in your proxy; see
   [frp's HTTPS-to-HTTP example](https://gofrp.org/en/docs/examples/https2http/).
   Keep App and the proxy running, then copy invitations from the room UI.

If you change **Site port**, update the proxy target too. This provides the site
and chat connection. Picture, voice and peer file transfers still need their
own [connections](./network.md); the HTTP tunnel does not provide those paths.

### Invite friends

- **To the site:** send its address. Friends can open it and choose a public room.
- **To a public room:** use the invitation button beside its title and **Copy room link**.
- **To a private room:** its owner uses **Copy password-free invitation** in the same place.
  If no invitation exists, select **Generate password-free invitation**. For a
  password-protected room, choose **Password-required link** to send a room link and share
  the password separately. The QR section
  below the copy action shares the same link.

Send private-room invitations only to people you want to admit to that room.
To replace a private link, expand **Reset room invitation**, then select
**Confirm invitation reset**. Old password-free links stop
working, while existing access and the room password remain.

![The room-title invitation opens copy, a subordinate QR section and invitation reset.](../assets/guide/channel-invitation.en.png#gh-light-mode-only)
![The room-title invitation opens copy, a subordinate QR section and invitation reset.](../assets/guide/channel-invitation.en.dark.png#gh-dark-mode-only)


### Use App with an existing site

1. Keep the 3.0 App running and open your group's **3.0** site.
2. Select **App → Open App page**. Allow local-network access if your browser
   asks. Check the site's address on the local page, then select **Allow access**.
3. Return to the site. In a lightweight channel, a new room runs in App if connected when you create it, or in the browser page otherwise. In a hosted channel, the server manages the room and keeps it available after you leave. Check the hosting note on the creation form.
4. In a room, **Start sharing** now also offers the App's supported sources.

Connecting App adds supported device features. Existing rooms keep their host.
Manage approved sites from the App launcher. See the
[App reference](../../prototype/channel-server/README.md#local-app-link) for details.

### Upgrading

Read the upgrade instructions supplied with your 3.0 test package, keep the
existing data directory unless those instructions require otherwise, and refresh
the Web page after updating App. For `unsupported_storage_version` or
`unsupported_domain_checkpoint`, follow the
[instructions for reopening your saved data](./troubleshooting.md#the-beta-app-reports-unsupportedstorageversion).
Public 2.x downloads are not the 3.0 test update.

## Share from an existing site

Open the 3.0 site address your group gave you or the invitation your friend sent. Choose a room you can enter.
You can also select **Create room** if the site allows it. Once inside, select **Start sharing** to show your screen or **Watch** beside a friend's screen. You can chat and join voice before anyone starts sharing.

Browser screen/camera access needs HTTPS or a localhost address. Available
sources and sound options depend on the browser and operating system. App is
optional for Browser capture; [connect it](#use-app-with-an-existing-site) for
the native sources supported by your device.

## When you leave or refresh

- **Stop sharing** ends that share. **Stop watching** ends your viewing;
  **Leave voice** ends your participation in that room's call.
- Closing your page ends its personal shares, viewing and voice. An
  **App-hosted room** continues while App runs; a **Browser-hosted room** is
  unavailable while its hosting page is closed. Switching rooms or collapsing
  sidebars keeps your other room activities running.
- Closing the App launcher page leaves App running. Stopping App ends the
  activities it runs and makes its hosted rooms unavailable across all its
  connected sites. Reopen App to host those rooms again.
- Confirmed chat history belongs to the room's host. Refreshing reloads history
  when that host is available; use **Earlier messages** for older pages.
  An unsent draft does not survive a page refresh. Captures and voice do not
  restart automatically when you reopen a page or App.

## Next steps

- [Sharing and playback](./sharing.md#playback-controls): viewing and sound controls.
- [Room tools](./room-tools.md): chat, voice and remote-control details.
- [Troubleshooting](./troubleshooting.md#common-problems): start from the symptom you see.
