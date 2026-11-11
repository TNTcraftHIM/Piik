# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Documentation](./README.md)

This guide is for the **3.0 test App and 3.0 links** supplied to testers.
The public online site and published downloads still belong to 2.x; use the
[published 2.6 guide](https://github.com/TNTcraftHIM/Piik/blob/v2.6.1/docs/guide/getting-started.md)
for those versions.

| You have… | Start here |
| --- | --- |
| A friend's 3.0 link | [Join their room](#join-a-friends-room). A browser is enough to watch. |
| A 3.0 test App package | [Create a room with App](#share-with-piik-app). |
| An existing 3.0 site | [Create a room in that site](#share-from-an-existing-site), with Browser or App hosting. |

A **site** contains your group's rooms. Anyone can create their own room. People in a room can
chat, join voice, share their own picture and choose which pictures to watch.

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
Keep their full link: opening your own App starts a different site.

## Use a 3.0 link without installing

Open a friend's 3.0 link or a 3.0 site supplied by your group, then follow
[joining a room](#join-a-friends-room). You can also share from the browser
where screen or camera capture is supported. `demo.piik.tv` is the public 2.x
site, not the entry for this test version.

## Share with Piik App

1. Use the **3.0 test package you received**. On Windows, extract the whole
   archive and open `piik-app.exe`; on Android, install the supplied APK and
   open Piik. Keep the desktop package's files together.
2. The launcher opens in your system browser. Choose a mode below, then
   select **Open Piik**. A fresh visit opens the room overview; the Piik mark
   returns there without stopping your shares, watches or voice.
3. On an empty site, select **Create your first room**. The name starts as
   **Living room**; change it if you like. Choose **Public** for everyone in the
   site or **Private** for invitation/password access. Check the hosting note,
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
- **Public invite:** for friends elsewhere. It creates a temporary Internet
  address while App is running. Send a new link if that address changes.

Local invitations use HTTPS. After starting **Local network**, return to the
App launcher and expand **Local connection details** below **Open Piik** to
read the address and certificate fingerprint. Compare it with the browser's
certificate before accepting its first warning; see the
[certificate steps](./troubleshooting.md#local-https-certificate-warning).

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
working, while existing access and the room password remain. If an older invitation
cannot be recovered, the panel explains this before you generate a replacement.

![The room-title invitation opens copy, a subordinate QR section and invitation reset.](../assets/guide/channel-invitation.en.png#gh-light-mode-only)
![The room-title invitation opens copy, a subordinate QR section and invitation reset.](../assets/guide/channel-invitation.en.dark.png#gh-dark-mode-only)


### Use App with an existing site

1. Keep the 3.0 App running and open your group's **3.0** site.
2. Select **App → Open App page**. Allow local-network access if your browser
   asks. Check the site's address on the local page, then select **Allow access**.
3. Return to the site. Connect App **before creating a room** if you want App
   hosting; the creation form tells you which runtime will host it.
4. In a room, **Start sharing** now also offers the App's supported sources.

Connecting App keeps an existing Browser-hosted room with its current host.
Manage approved sites from the App launcher. See the
[App reference](../../prototype/channel-server/README.md#local-app-link) for details.

### Upgrading

Read the upgrade instructions supplied with your 3.0 test package, then refresh
the Web page after updating App. If App reports `unsupported_domain_checkpoint`,
it has preserved data from an older test format. Keep that data and follow the
package's fresh-data instructions; [saved-data settings](../../prototype/channel-server/README.md#saved-data-and-files)
explain the separate App and Server directories. Public 2.x downloads are not
the 3.0 test update. If the beta reports `unsupported_storage_version`, stop
App and run the supplied `reset-beta-app-data.ps1`; it keeps the old App
directory as a timestamped backup.

## Share from an existing site

Open your group's 3.0 address or room invitation, then select
**Create room** or choose a room you can enter. Follow
[the room and sharing steps above](#share-with-piik-app), starting at step 3.
You can chat and join voice before anyone shares a picture.

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
