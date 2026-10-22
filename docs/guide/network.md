# Advanced network checks

English · [简体中文](./network.zh-CN.md) · [Troubleshooting](./troubleshooting.md)

Use this page when **the page opens, but picture or voice will not connect**.
Choose the relevant check:

- **Campus/work network, or the same invite works on a hotspot:** [connection options](#campus-networks-and-strict-nat).
- **The same invite works in another browser:** [browser restrictions](#browser-webrtc-restrictions).
- **Logs mention STUN, or you manage the router:** [discovery and router checks](#stun-ipv6-and-router-checks).
- **Using Tailscale, ZeroTier or UU:** [virtual LAN steps](#optional-a-virtual-lan).

Web pages, invitations and chat use different connections from picture and sound.
Entering a room or sending a message does not establish that media can connect.

![The Host and friend access the site for web and chat; picture and sound use a separate direct or forwarded media connection.](../assets/guide/network-paths.en.svg)

If the [invitation page will not open](./troubleshooting.md#public-invitation-fails-or-shows-1033),
or [video already plays but blurs or stutters](./troubleshooting.md#picture-blurs-stutters-or-stops), start with that symptom instead.

## Campus networks and strict NAT

**Open the same invitation on a phone hotspot first.** If it works there but not
on the original network, investigate that network's shared gateway or firewall.

For regular use, choose an option that fits your group:

- **You have a Piik site:** ask its operator to [enable server media forwarding (SFU)](../operations/self-hosting.md#optional-media-fallback). The Host turns off **Privacy mode** so forwarding can be tried if direct connections fail. For App capture, [approve the new site](./getting-started.md#use-app-with-an-existing-site), then send its invitation.
- **Everyone can install a networking tool:** use the [virtual LAN steps](#optional-a-virtual-lan) below with the App's **Local room**.
- **The required connections are blocked:** use an available network or ask its administrator to review access.

> **Online and Public invite limits:** `demo.piik.tv` and App **Public invite** are P2P-only, without server media fallback. Both P2P and SFU media currently need UDP; hosting the web page alone does not resolve blocked media UDP.

## Browser WebRTC restrictions

Browser WebRTC settings, VPNs and privacy extensions may block picture and sound.
This can also affect the Browser-to-App connection on the same computer;
successful source selection does not prove that media can connect.

1. Open the same invitation in a browser profile with default settings and no relevant privacy extensions.
2. If it works, check **WebRTC** or **IP-leak protection** in the original browser and restore a policy that allows WebRTC UDP.
3. Reload Piik and retry sharing or viewing. School/company-managed settings need an administrator's review.

<details>
<summary>Chrome / Vivaldi settings</summary>

`disable_non_proxied_udp` restricts UDP that does not use a proxy. Compare with
the browser default. Chrome extensions may control this policy without a visible
browser switch. Vivaldi provides **Settings → Privacy and Security → WebRTC IP
Handling → Broadcast IP for Best WebRTC Performance**.

Hiding local IP addresses alone does not necessarily block WebRTC. Direct connections
can expose network addresses to peers; change only the relevant setting. See
[Chrome's policy reference](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)
and [Vivaldi's privacy settings](https://help.vivaldi.com/desktop/privacy/privacy-settings/).

</details>

## STUN, IPv6 and router checks

These checks are for App users reading logs and people who manage a site or router.
Only change the parts you manage.

<details>
<summary>STUN discovery and settings</summary>

App Public invite uses several discovery services. **One STUN error does not
mean every path failed.** To replace all built-in addresses, set
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

A virtual LAN connects devices in different places, so you can share through
Piik App's **Local room**. The tool must provide reachable virtual IPv4 addresses
and carry both web traffic and WebRTC UDP; acceleration limited to one game does
not suffice. Choose a tool available to everyone in your group:

- **[Tailscale](https://tailscale.com/docs/how-to/quickstart):** install it on each device and invite friends to the same private network (*tailnet*). In Piik, select the Host's Tailscale IPv4 address (`100.x.y.z`).
- **[ZeroTier](https://docs.zerotier.com/quickstart/):** join the same network ID on each device, then authorize those devices in its management console. In Piik, select the Host's assigned virtual IPv4 address.
- **[UU (Chinese guide)](https://uu.163.com/blog/lan-multiplayer-guide-net.html):** use the general-purpose LAN option and join the same room. In Piik, select the Host's UU virtual IPv4 address.

![Virtual LAN in three steps: join the same virtual network, choose its address in Local room, then send the complete invitation and confirm the certificate.](../assets/guide/virtual-lan.en.svg)

1. **Join the same network.** The Host and friends run the tool and join the same virtual LAN.
2. **Host selects its address.** In the updated Piik App, choose **Local room**, expand **Local invitation address**, select the tool's virtual IP, then enter the room and share.
3. **Send the complete invitation.** Friends open the HTTPS invitation on that virtual IP. On first access, [confirm the local certificate](./troubleshooting.md#local-https-certificate-warning) with the Host before entering. Do not send `localhost` or only a room code.
4. **Check picture and sound.** Everyone keeps the networking tool running; the Host also keeps Piik App running. If the virtual IP changes, the Host selects the new address and sends a new invitation.

Piik has been tested across Windows devices using UU. Tailscale and ZeroTier
have not yet been tested with Piik; use the checks below to verify your setup.

If something fails, start with the first failing step:

- **Page will not open:** check [local invitations and firewall permissions](./troubleshooting.md#local-invitation-will-not-open) for that virtual network.
- **Page opens, media will not connect:** check that the tool carries media UDP and review [browser WebRTC settings](#browser-webrtc-restrictions). Web connectivity does not establish media connectivity.
- **Microphone or remote control is unavailable:** use the App-generated HTTPS invitation, confirm its certificate, then check [browser permissions](./troubleshooting.md#microphone-or-remote-controls-are-unavailable). Supporting browsers can use these features without a public tunnel, just as on an ordinary LAN.

Join only with trusted friends. Firewalls, browser address discovery and the
third-party service still affect availability.

<details>
<summary>Use frp with an existing server</summary>

For administrators with a public server, the [frp recipe](../operations/self-hosting.md#optional-forward-an-existing-server-with-frp)
forwards an existing site's web and SFU endpoints through frps. Forwarding the
web page alone does not forward WebRTC media.

</details>

If the issue persists, [collect reports](./troubleshooting.md#reporting-a-problem) from the same attempt.
