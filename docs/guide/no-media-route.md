# No picture after joining a room (“No media route available”)

You’re in the room, but the stream hasn’t reached your screen. Reload once to reconnect, or choose an option below.

[Only I have no picture](#i-get-no-picture-but-other-viewers-can-watch) · [Nobody gets a picture](#nobody-gets-a-picture) · [Connect over a virtual LAN](./network.md#optional-a-virtual-lan)

![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.png#gh-light-mode-only)
![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.dark.png#gh-dark-mode-only)

## I get no picture, but other viewers can watch

- **Try another browser.** Open the same invitation there. If the picture plays, you can keep watching in that browser. [Connection settings in the original browser](./network.md#browser-webrtc-restrictions)
- **Try another network.** Open the same **public invitation** using mobile data or a phone hotspot. If the picture plays, you can keep watching on that network.

- **Only people who joined later are stuck.** Ask someone who can watch to keep the room open. If their **My relay limit** is **0**, they can raise it under **Playback settings → Connection**. The other viewers can then reload. [Forwarding limits](./sharing.md#connection-preferences)

## Nobody gets a picture

- **The Host’s preview is black or sharing has stopped.** The Host can select an ordinary window, choose **Start sharing**, and check that the window appears in the preview. [Choose what to share](./sharing.md#start-sharing)
- **The Host sees the preview, but friends can’t watch.** Connect over a virtual LAN. Everyone joins the same virtual network. In Piik App, the Host opens **Local room → Local invitation address**, selects the IP from the virtual LAN tool, enters the room and starts sharing. Send friends the complete new invitation. [Choose the address with screenshots](./network.md#optional-a-virtual-lan)
- **You have a site that can forward media.** Ask its operator to confirm media forwarding (SFU) is enabled. The Host turns off **Privacy mode** on that site, starts sharing, and sends the new room invitation. Piik can then try the server when a direct connection fails. [Use Piik App with an existing site](./getting-started.md#use-app-with-an-existing-site)

App’s public invitation service makes the room page reachable. When you use that invitation or Piik online, the Host or another viewer sends the picture.

If you can’t open the room page, see [how to join your friend’s room](./troubleshooting.md#i-cannot-join-my-friends-room). If the picture plays but you can’t hear it, see [sound help](./sound-help.md).
