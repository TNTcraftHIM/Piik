# Advanced network checks

These instructions cover the 3.0 internal test. For the public release, see the [published guide](https://piik.tv/docs/network.html).

English · [简体中文](./network.zh-CN.md) · [Troubleshooting](./troubleshooting.md)

If the site opens but picture, voice or file downloads will not connect, choose the symptom below. If you cannot open the site or enter a room, see [Troubleshooting](./troubleshooting.md#common-problems).

- **The same invitation works in another browser:** [check WebRTC restrictions](#browser-webrtc-restrictions).
- **It works on a hotspot but not your usual network:** [compare connection options](#campus-networks-and-strict-nat).
- **Friends on different networks cannot exchange media or files:** [try a shared virtual LAN](#optional-a-virtual-lan).
- **You have discovery errors or manage the router:** [check STUN, IPv6 and mappings](#stun-ipv6-and-router-checks).

The site connection carries text, history, message reactions and attachment
descriptions to the room host. Pictures, voice and file content use separate
peer connections. If chat also fails, first check the [site connection and room hosting](./troubleshooting.md#chat-or-history-will-not-load).

![Participants exchange text, history and attachment descriptions through the site with the room host; pictures, voice and file content use peer connections.](../assets/guide/network-paths.en.svg)

## Campus networks and strict NAT

If only one viewer is affected, have that viewer switch to a phone hotspot and reopen the same invitation. Keep the sharer on their current network for this comparison. If media or file transfer works
there but not on the original network, compare that network's UDP, VPN and
firewall rules. A working web page does not establish that peer traffic is allowed.

- Try a browser profile with default WebRTC settings, as described below.
- If your group can use a shared virtual network, follow the [virtual LAN steps](#optional-a-virtual-lan).
- On a managed network, ask the network administrator about blocked UDP, or use another network.
- If the site runs on Piik Server, ask the site operator whether site forwarding is available.
  A room manager can then enable **Allow site forwarding** under **Room settings → Connection**.

Piik selects routes automatically. The App's automatic **Public invite** uses
Cloudflare Tunnel for the invitation page and signaling. Picture, voice and file
content still need a working WebRTC route.
[Cloudflare Tunnel routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)

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

STUN discovers addresses that peer connections can try. In **Local network** mode,
App supplies only its STUN address on the selected network. **Public invite** and
standalone Server supply public STUN addresses by default.
Changing STUN only changes address discovery. If the site operator already has a
TURN service, they can check compatible builds and configuration in the
[App and Server ICE configuration reference](../../prototype/channel-server/README.md#ice-server-configuration).

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

1. Everyone runs the networking tool on their device and joins the same virtual network.
2. On the device running Piik App, the person hosting the local site checks the virtual IPv4 address assigned to that device by the networking tool. In the Piik App launcher, choose **Local network**, select that same address and click **Open Piik**. If App is running in another mode, finish its current activities. Clear **Open my site when App starts** if enabled, then quit normally and reopen App.
3. The host creates or opens the room, copies the room invitation generated by Piik and sends it to friends. Friends [confirm the local certificate](./troubleshooting.md#local-https-certificate-warning) with the host before joining.
4. Try sending a chat message, then try watching, voice or a file download. Everyone keeps the networking tool running. The host also keeps Piik App running.

If the virtual address changes, select the new address and send a fresh link.
Do not send `localhost`, which points to each recipient's own device.

- **Page will not open:** check whether the tool carries web traffic to the Piik App device, then review [local access and firewall rules](./troubleshooting.md#local-invitation-will-not-open).
- **Chat/history will not load:** check [room hosting](./troubleshooting.md#chat-or-history-will-not-load).
- **Chat works, but picture, voice or files do not:** check whether the tool carries WebRTC UDP between the devices, then review [WebRTC restrictions](#browser-webrtc-restrictions).
- **Microphone or remote-control permission is unavailable:** use the HTTPS invitation and review [browser permissions](./troubleshooting.md#microphone-or-remote-controls-are-unavailable).

Join only with trusted friends. If the issue persists, [collect reports](./troubleshooting.md#reporting-a-problem) from the same attempt.

To give an App or Server a fixed public invitation address, use a managed or self-hosted tunnel. [frp and SakuraFrp guide](./frp.md)
