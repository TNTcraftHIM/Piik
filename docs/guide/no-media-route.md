# No picture after joining a room (“No media route available”)

You’ve joined the room, but the Host’s picture and sound haven’t reached your device. Reload once to reconnect. If the picture still won’t play, you can [join a virtual LAN with your friends](./network.md#optional-a-virtual-lan) or choose the situation that matches yours.

## I get no picture, but other viewers can watch

Open the same **public invitation** using mobile data or a phone hotspot. If the picture plays, you can keep watching on that network.

If only people who joined later are stuck, ask someone who can watch to keep the room open. If their **My relay limit** is **0**, they can raise it under **Playback settings → Connection** so Piik can try forwarding through them. [Forwarding limits](./sharing.md#connection-preferences)

## Nobody gets a picture

- **The Host’s preview is black or sharing has stopped.** The Host can select an ordinary window, choose **Start sharing**, and check that the window appears in the preview. [Choose what to share](./sharing.md#start-sharing)
- **The Host’s preview works.** Invite someone on another network. If they can watch, ask them to keep the room open while the others retry. You can also use a virtual LAN. Everyone joins the same virtual network. In Piik App, the Host chooses **Local room → Local invitation address**, selects the address from the virtual LAN tool, starts sharing, and sends the new invitation. [Virtual LAN setup with pictures](./network.md#optional-a-virtual-lan)
- **You have a site that can forward media.** Ask its operator to enable media forwarding (SFU). The Host turns off **Privacy mode** on that site, starts sharing, and sends the new room invitation. Piik can then try the server when a direct connection fails. [Use Piik App with an existing site](./getting-started.md#use-app-with-an-existing-site)

App’s public invitation service makes the room page reachable. When you use that invitation or Piik online, the Host or another viewer sends the picture.

![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.png#gh-light-mode-only)
![The viewer’s “No media route available” message with the Troubleshooting link.](../assets/guide/viewer-route-failure.en.dark.png#gh-dark-mode-only)

If you can’t open the room page, see [how to join your friend’s room](./troubleshooting.md#i-cannot-join-my-friends-room). If the picture plays but you can’t hear it, see [sound help](./sound-help.md).
