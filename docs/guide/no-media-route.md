# No picture after joining a room

English · [简体中文](./no-media-route.zh-CN.md)

<a id="no-picture-after-joining-a-room-no-media-route-available"></a>

## No media route available

Ask whether another viewer can see the picture. If someone can, go to [only my picture is missing](#i-get-no-picture-but-other-viewers-can-watch). If nobody can watch, ask the host to check their preview.

If your Android device joined over a virtual LAN, [check its virtual LAN connection](./troubleshooting.md#android-cannot-open-a-virtual-lan-invitation).

- **The App says the local preview is unavailable but sharing continues.** The host can reconnect their preview from **Playback settings**. Check [viewer connections](#nobody-gets-a-picture) separately.
- **The shared source itself is blank.** Ask the host to share an open window, such as a browser window. Once it appears in the preview, open the invitation again. [Start sharing](./sharing.md#start-sharing)
- **The host can see the picture.** Follow [nobody gets a picture](#nobody-gets-a-picture).

## I get no picture, but other viewers can watch

- **Try another browser.** Open the same invitation there. If the picture plays, you can keep watching in that browser. [Connection settings in the original browser](./network.md#browser-webrtc-restrictions)
- **Try another network.** Open the same **public invitation** using mobile data or a phone hotspot. If the picture plays, you can keep watching on that network.
- **Only people who joined later are stuck.** Ask someone who can watch to keep the room open. If their **My relay limit** is **0**, they can raise it under **Playback settings → Connection**. The other viewers can then reload. [Forwarding limits](./sharing.md#connection-preferences)

## Nobody gets a picture

If the invitation is public, first ask one viewer to open the same link on mobile data. If the picture plays there, check [restrictions on the original network](./network.md#campus-networks-and-strict-nat).

- **Friends are on different networks and a direct connection still fails.** Everyone can [join the same virtual LAN](./network.md#optional-a-virtual-lan). The Host looks up their own device’s IPv4 address in the networking tool, then selects the matching address in Piik App under **Local room → Local invitation address**. Once sharing starts, the Host sends friends the complete new invitation link.
- **You have a site that can forward media.** Ask its operator to confirm media forwarding (SFU) is enabled. The Host turns off **Privacy mode** on that site, starts sharing, and sends the new room invitation. Piik can then try the server when a direct connection fails. [Use Piik App with an existing site](./getting-started.md#use-app-with-an-existing-site)

![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.png#gh-light-mode-only)
![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.dark.png#gh-dark-mode-only)

If you can’t open the room page, see [how to join your friend’s room](./troubleshooting.md#i-cant-join-my-friends-room). If the picture plays but you can’t hear it, see [sound help](./sound-help.md).
