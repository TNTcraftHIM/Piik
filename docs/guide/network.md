# Advanced network checks

This guide covers the 3.0 internal test. For the published version, use the [2.6.1 network guide](https://github.com/TNTcraftHIM/Piik/blob/v2.6.1/docs/guide/network.md).

English · [简体中文](./network.zh-CN.md) · [Troubleshooting](./troubleshooting.md)

Start with the [basic symptom checks](./troubleshooting.md#common-problems).
Use this page when **the site opens, but picture, voice or file downloads still cannot connect**.

- **The same invitation works in another browser:** [check WebRTC restrictions](#browser-webrtc-restrictions).
- **It works on a hotspot but not your usual network:** [compare connection options](#campus-networks-and-strict-nat).
- **Friends on different networks cannot exchange media or files:** [try a shared virtual LAN](#optional-a-virtual-lan).
- **You have discovery errors or manage the router:** [check STUN, IPv6 and mappings](#stun-ipv6-and-router-checks).

The site connection carries text, history, message reactions and attachment
descriptions to the room host. Pictures, voice and file content use separate
peer connections. If chat also fails, first check the [site connection and room hosting](./troubleshooting.md#chat-or-history-will-not-load).

![Participants exchange text, history and attachment descriptions through the site with the room host; pictures, voice and file content use peer connections.](../assets/guide/network-paths.en.svg)

## Campus networks and strict NAT

Open the same invitation on a phone hotspot. If media or file transfer works
there but not on the original network, compare that network's UDP, VPN and
firewall rules. A working web page does not establish that peer traffic is allowed.

- Try a browser profile with default WebRTC settings, as described below.
- If your group can use a shared virtual network, follow the [virtual LAN steps](#optional-a-virtual-lan).
- On a managed network, ask the administrator about blocked UDP, or use another network.

Piik selects routes automatically. Use the connection options below when the
current network blocks peer traffic.

## Browser WebRTC restrictions

Browser settings, VPNs and privacy extensions can block peer traffic even while
the site connection and chat work.

1. Open the same invitation in a browser profile with default settings and no relevant privacy extensions.
2. If it works, check **WebRTC** or **IP-leak protection** in the original browser. Allow the UDP traffic needed for peer connections.
3. Retry watching, voice or the file download. Ask an administrator about centrally managed settings.

<details>
<summary>Chrome / Vivaldi settings</summary>

`disable_non_proxied_udp` restricts UDP that does not use a proxy. Chrome
extensions can control this policy without a visible browser switch. Vivaldi
offers **Settings → Privacy and Security → WebRTC IP Handling → Broadcast IP
for Best WebRTC Performance**.

Direct connections reveal network addresses to peers. Change the setting
blocking your connection, keeping other privacy settings as needed. See
[Chrome's policy reference](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)
and [Vivaldi's privacy settings](https://help.vivaldi.com/desktop/privacy/privacy-settings/).

</details>

## STUN, IPv6 and router checks

These checks are for people reading App logs or managing the site or router.
Only change equipment and settings you manage.

<details>
<summary>STUN discovery</summary>

STUN discovers addresses that peer connections can try. It does not carry chat
or file content. App and Server use the built-in public STUN choices; operators
can configure `PIIK_CHANNEL_ICE_SERVERS` as described in the
[runtime reference](../../prototype/channel-server/README.md#rooms-conversation-and-media).
An HTTP reverse proxy does not forward STUN UDP. Replacing STUN cannot by itself
remove a network's UDP restrictions.

Choose trusted services: they receive participants' public IP addresses. The
[WebRTC connection guide](https://webrtc.org/getting-started/peer-connections)
explains discovery.

</details>

<details>
<summary>IPv6 and router mappings</summary>

When the provider, router and both devices have usable IPv6, Piik can try it
alongside IPv4. Keep IPv4 enabled too; IPv6 remains subject to firewall rules.
Consult your router's [IPv6 guidance](https://support.google.com/googlehome/answer/6361450).

Supported UPnP, PCP or NAT-PMP can let the Native App request mappings for its
peer socket; the browser does not request those mappings. A mapping does not
make an unreachable invitation page accessible. If both modem and router perform
NAT, your model's bridge/AP instructions may remove a layer. Back up settings first.
Carrier-grade NAT is upstream; ask the provider about public IPv4 or IPv6.

See manufacturer guidance on [UPnP](https://support.google.com/googlehome/answer/6274337)
and [double NAT](https://www.tp-link.com/us/support/faq/3113/).

</details>

## Optional: a virtual LAN

If friends on different networks cannot exchange pictures, voice or files, a
shared virtual LAN is one option. It must carry web traffic and WebRTC UDP,
with virtual addresses that all participants can reach. A game-only accelerator
is insufficient. Choose a tool everyone in your group can use:

- **[Tailscale](https://tailscale.com/docs/how-to/quickstart):** install it on each device and invite friends to the same private network (*tailnet*). Use the App owner's Tailscale IPv4 address (`100.x.y.z`).
- **[ZeroTier](https://docs.zerotier.com/quickstart/):** join the same network ID, then authorize the devices in its management console. Use the App owner's assigned virtual IPv4 address.
- **[UU (Chinese guide)](https://uu.163.com/blog/lan-multiplayer-guide-net.html):** use the general-purpose LAN option and join the same room. Use the App owner's UU virtual IPv4 address.

![Join the same virtual network, select its address in the App's Local network mode, then send the site address or room link and confirm the local certificate.](../assets/guide/virtual-lan.en.svg)

1. Everyone runs the networking tool and joins the same virtual network.
2. In the App launcher, choose **Local network** and select the tool's virtual IP from the available invitation addresses, then **Open Piik**. If another mode is already running, finish its shares and reopen App before selecting the mode.
3. Create or open the intended room. Send the site address or room link using that virtual address. Friends [confirm the local certificate](./troubleshooting.md#local-https-certificate-warning) with the App owner before entering.
4. Try chat, then **Watch**, voice or the file download. Everyone keeps the networking tool running; the App owner also keeps Piik App running.

If the virtual address changes, select the new address and send a fresh link.
Do not send `localhost`, which points to each recipient's own device.

- **Page will not open:** check [local access and firewall rules](./troubleshooting.md#local-invitation-will-not-open).
- **Chat/history will not load:** check [room hosting](./troubleshooting.md#chat-or-history-will-not-load).
- **Chat works, but picture, voice or files do not:** check that the tool carries UDP and review [WebRTC restrictions](#browser-webrtc-restrictions).
- **Microphone or remote-control permission is unavailable:** use the HTTPS invitation and review [browser permissions](./troubleshooting.md#microphone-or-remote-controls-are-unavailable).

Join only with trusted friends. If the issue persists, [collect reports](./troubleshooting.md#reporting-a-problem) from the same attempt.
