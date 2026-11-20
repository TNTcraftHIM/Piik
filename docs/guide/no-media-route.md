# No picture after joining a room

<a id="no-picture-after-joining-a-room-no-media-route-available"></a>

If you see “No media route available”, ask the host to look at their sharing preview.

- **The host sees a blank preview too.** Ask them to share an open window, such as a browser window. Once it appears in the preview, open the invitation again. [Start sharing](./sharing.md#start-sharing)
- **The host can see the picture.** Ask whether anyone else can watch. Choose [only my picture is missing](#i-get-no-picture-but-other-viewers-can-watch) or [nobody gets a picture](#nobody-gets-a-picture).

## I get no picture, but other viewers can watch

- **Try another browser.** Open the same invitation there. If the picture plays, you can keep watching in that browser. [Connection settings in the original browser](./network.md#browser-webrtc-restrictions)
- **Try another network.** Open the same **public invitation** using mobile data or a phone hotspot. If the picture plays, you can keep watching on that network.
- **Only people who joined later are stuck.** Ask someone who can watch to keep the room open. If their **My relay limit** is **0**, they can raise it under **Playback settings → Connection**. The other viewers can then reload. [Forwarding limits](./sharing.md#connection-preferences)

## Nobody gets a picture

- **The Host sees the preview, but friends can’t watch.** Everyone can [join the same virtual LAN](./network.md#optional-a-virtual-lan). The Host looks up their own device’s IPv4 address in the networking tool, then selects the matching address in Piik App under **Local room → Local invitation address**. Once sharing starts, the Host sends friends the complete new invitation link.
- **You have a site that can forward media.** Ask its operator to confirm media forwarding (SFU) is enabled. The Host turns off **Privacy mode** on that site, starts sharing, and sends the new room invitation. Piik can then try the server when a direct connection fails. [Use Piik App with an existing site](./getting-started.md#use-app-with-an-existing-site)

![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.png#gh-light-mode-only)
![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.dark.png#gh-dark-mode-only)

If you can’t open the room page, see [how to join your friend’s room](./troubleshooting.md#i-cannot-join-my-friends-room). If the picture plays but you can’t hear it, see [sound help](./sound-help.md).
