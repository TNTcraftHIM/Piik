# Advanced network checks

English · [简体中文](./network.zh-CN.md) · [Troubleshooting](./troubleshooting.md)

If you can open the room but can’t see your friend’s stream, see [No picture after joining a room](./no-media-route.md). If you have already tried another browser or network, choose the situation that matches yours.

- **The same invite works in another browser:** [browser restrictions](#browser-webrtc-restrictions).
- **The same invitation works on a hotspot.** [What to do when your usual network blocks the stream](#campus-networks-and-strict-nat)
- **Friends in another location cannot reach your local invitation:** [connect through a virtual LAN](#optional-a-virtual-lan).
- **Logs mention STUN, or you manage the router:** [discovery and router checks](#stun-ipv6-and-router-checks).

If a [public-invitation page will not open](./troubleshooting.md#public-invitation-fails-or-shows-1033)
or [video plays but blurs or stutters](./troubleshooting.md#the-picture-is-blurry-or-keeps-freezing), follow that symptom instead.

Web pages and chat use a separate connection from picture and sound:

![The Host and friend access the site for web and chat; picture and sound use a separate direct or forwarded media connection.](../assets/guide/network-paths.en.svg)

## Campus networks and strict NAT

**For a public invitation, try opening the same link on a phone hotspot.** If you can watch there, keep using the hotspot or ask the person who manages your usual network for help.

For regular use, choose an option that fits your group:

- **You have a Piik site:** ask its operator to confirm that picture and sound forwarding is enabled. The Host turns off **Privacy mode** on that site, starts sharing, and sends the new room invitation. Piik can try forwarding through the site if a direct connection fails. [Site setup](../operations/self-hosting.md#optional-media-fallback) · [Use the App with an existing site](./getting-started.md#use-app-with-an-existing-site)
- **No usable forwarding site, and direct media still will not connect:** a [virtual LAN](#optional-a-virtual-lan) offers another path. Everyone joins the same virtual network, then uses the App's **Local room**.

<details>
<summary>For site administrators · Media forwarding</summary>

**Media requires UDP.** `demo.piik.tv` and App **Public invite** use P2P-only media.
SFU forwarding requires a site with that feature enabled and a reachable UDP endpoint.

</details>

## Browser WebRTC restrictions

1. Open the same invitation in another browser. If the picture appears, you can keep watching there.
2. To keep using your original browser, try a fresh profile with default settings. If that works, check the privacy extensions in your original profile. If neither browser shows the picture, try a public invitation on a phone hotspot. For a local invitation, keep both devices on the same LAN or virtual LAN.

<details>
<summary>Advanced · Chrome and Vivaldi privacy settings</summary>

Browser or VPN policies can block picture connections, including capture through App on the same computer. Check **WebRTC** or **IP-leak protection** in the original profile. For a school or work device, ask the administrator.

`disable_non_proxied_udp` restricts UDP that does not use a proxy. Compare with
the browser default. Chrome extensions may control this policy without a visible
browser switch. Vivaldi provides **Settings → Privacy and Security → WebRTC IP
Handling → Broadcast IP for Best WebRTC Performance**.

Direct connections can expose network addresses to peers. Change the setting
that blocks UDP, keeping other privacy settings as needed. See
[Chrome's policy reference](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)
and [Vivaldi's privacy settings](https://help.vivaldi.com/desktop/privacy/privacy-settings/).

</details>

## STUN, IPv6 and router checks

These checks are for App users reading logs and people who manage a site or router.
Only change the parts you manage.

<details>
<summary>STUN discovery and settings</summary>

STUN discovers the addresses devices can use to connect. App Public invite tries
several services; if discovery fails, replace the built-in addresses with
[`PIIK_STUN_URLS`](../standards/configuration.md#piik-app-configuration) before
starting Public invite. Site operators should check that `STUN_URLS` points to
reachable UDP services; an HTTP reverse proxy does not forward STUN.

Choose trusted services: they receive participants' public IP addresses. The
[WebRTC connection guide](https://webrtc.org/getting-started/peer-connections)
explains discovery.

</details>

<details>
<summary>Check IPv6 connectivity</summary>

When the provider, router and both devices have usable IPv6, Piik can try it
alongside IPv4. Keep IPv4 enabled too; IPv6 still obeys firewall rules.
Router menus vary; consult your manufacturer's
[IPv6 guidance](https://support.google.com/googlehome/answer/6361450).

</details>

<details>
<summary>Router mappings and shared addresses</summary>

Supported UPnP, PCP or NAT-PMP can let App's native media path request port
mappings; browser-only capture does not request them. If both modem and router
perform NAT, your model's bridge/AP-mode instructions may remove a layer.
Back up settings first. Carrier-grade NAT is upstream; ask your provider about
public IPv4 or IPv6.

See manufacturer guidance on [UPnP](https://support.google.com/googlehome/answer/6274337)
and [double NAT](https://www.tp-link.com/us/support/faq/3113/).

</details>

## Optional: a virtual LAN

Friends in different places can use a virtual LAN to connect their devices and share with Piik App’s **Local room**. Choose a tool with a LAN networking mode that everyone can join.

- **[Tailscale](https://tailscale.com/docs/how-to/quickstart):** install it on each device and invite friends to the same private network (*tailnet*). In Piik, select the Host's Tailscale IPv4 address (`100.x.y.z`).
- **[ZeroTier](https://docs.zerotier.com/quickstart/):** join the same network ID on each device, then authorize those devices in its management console. In Piik, select the Host's assigned virtual IPv4 address.
- **[UU (Chinese guide)](https://uu.163.com/blog/lan-multiplayer-guide-net.html):** use the general-purpose LAN option and join the same room. In Piik, select the Host's UU virtual IPv4 address.

![Virtual LAN in three steps: join the same virtual network, choose its address in Local room, then send the complete invitation and confirm the certificate.](../assets/guide/virtual-lan.en.svg)

1. **Join the same network.** The Host and friends run the tool and join the same virtual LAN.
2. **The Host chooses an address in Piik.** Find your own device’s IPv4 address in the networking tool. Open Piik App, choose **Local room**, expand **Local invitation address**, and select the matching address. Enter the room and start sharing. The example below uses `192.0.2.30`.

   ![The Local invitation address field shows the selected example virtual adapter and its IPv4 address.](../assets/guide/virtual-lan-address.en.png#gh-light-mode-only)
   ![The Local invitation address field shows the selected example virtual adapter and its IPv4 address.](../assets/guide/virtual-lan-address.en.dark.png#gh-dark-mode-only)

3. **Send the complete invitation.** The Host copies the full HTTPS invitation from Piik and sends it to friends. The link should contain the virtual IPv4 address just selected. Friends open the link and confirm the certificate with the Host before entering for the first time. [Confirm the local certificate](./troubleshooting.md#local-https-certificate-warning)
4. **Ask a friend to try it.** They should see the shared picture and hear any sound the Host chose to share. Everyone keeps the networking tool running, and the Host keeps Piik App open. If the virtual IP changes, the Host selects the new address and sends a new invitation.

If something fails, start with the first failing step:

- **Page will not open:** check [local invitations and firewall permissions](./troubleshooting.md#local-invitation-will-not-open) for that virtual network.
- **The page opens but the picture won’t play.** The virtual LAN needs to carry both web traffic and UDP between devices. Check that everyone joined using the tool’s general LAN mode, then check [WebRTC settings in the browser](#browser-webrtc-restrictions).
- **Microphone or remote control is unavailable:** use the App-generated HTTPS invitation, confirm its certificate, then check [browser permissions](./troubleshooting.md#microphone-or-remote-controls-are-unavailable). Supporting browsers can use these features without a public tunnel, just as on an ordinary LAN.

Join only with trusted friends.

To give an App or Server a fixed public invitation address, use a managed or self-hosted tunnel. [frp and SakuraFrp guide](./frp.md)

If the issue persists, [collect reports](./troubleshooting.md#reporting-a-problem) from the same attempt.
