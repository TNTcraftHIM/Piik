# Browser NAT Traversal

Last reviewed: 2026-08-31

This document owns evidence for improving direct Browser ICE without adding a
new relay or a custom transport. The current product contract remains standard
WebRTC ICE with STUN discovery and bounded SFU fallback.

## Confirmed Boundaries

- ICE already gathers IPv4 and IPv6 candidates when the Browser and configured
  STUN service can use those address families. STUN discovers addresses; it
  does not carry media.
- Host candidates may be concealed behind mDNS names. The mDNS ICE design sends
  normal STUN requests for both address families and produces IP-valued srflx
  candidates, so a reachable dual-stack STUN endpoint preserves cross-network
  IPv6 discovery even when a host address is concealed.
- Chromium's shared UDP port sends to multiple configured STUN servers. Its
  tests retain two srflx candidates when the servers report different mapped
  addresses and deduplicate the result when they report the same address.
- A STUN operator observes the client's source address, source port, request
  time and protocol metadata. It never receives the DTLS-SRTP media path. An
  external STUN endpoint is therefore a metadata dependency, not a media relay.
- The flagship server currently has no global IPv6 address or AAAA record. Its
  `inet` firewall already permits UDP 3478 for both families, coturn already
  supports AF_INET6 and binds `::1`, and the existing `STUN_URLS` wire accepts a
  bounded list. Self-hosted dual-stack discovery is blocked only by cloud ENI,
  public IPv6, DNS and cloud-security-group provisioning.

On 2026-08-31, Chrome 151 on Windows gathered a host plus IPv4 srflx candidate
through the self-hosted STUN endpoint and independently through Cloudflare's
official STUN endpoint while the machine used TUN and fake-IP DNS. With both
configured, Chromium emitted one deduplicated srflx candidate. No raw address or
port was retained. This proves reachability and the no-duplicate EIM behavior;
it does not prove an IPv6 candidate or an IPv6 Peer connection on the target
networks.

## Current Decision

Retain the self-hosted IPv4 STUN endpoint and add Cloudflare's official
dual-stack STUN endpoint in the flagship deployment. Cloudflare documents that
this STUN service is free and does not operate from its China Network, so the
self-hosted endpoint remains an independent local-region discovery path.
Trickle ICE allows either endpoint to contribute candidates without waiting for
the other to finish. Removing the external URL is the complete rollback.

A fully self-hosted dual-stack endpoint remains preferable once the cloud ENI
has private IPv6, an EIPv6 is bound, the AAAA record exists, and UDP 3478 is
admitted by the cloud security group. The coturn and host-firewall templates do
not need another media port or TURN configuration for that transition.

## Rejected Product Inference

Multiple STUN destinations can expose whether one current socket received the
same or different mappings. They do not establish a stable participant-wide NAT
type:

- RFC 5780 behavior discovery requires carefully controlled alternate address
  tests, warns that adding destinations can change observed behavior, and says
  results can vary by source port or become more restrictive later.
- Mapping behavior does not reveal filtering behavior. A Browser cannot infer
  that a Peer pair is impossible from mapping samples alone.
- A global `eim | edm` fact would cross connection generations, interfaces,
  VPN/TUN routes and physical network changes that own different sockets.

Therefore NAT samples must not skip a P2P candidate, alter the committed graph,
or become a persistent participant capability. Port prediction and synthetic
candidate injection remain experiments until controlled Browser and target-
network measurements prove both benefit and bounded false rejection. They do
not enter the current protocol or controller.

QUIC on UDP 443 does not change this Browser boundary. WebRTC's ICE agent owns
its UDP sockets and candidate checks; the Web application cannot replace that
transport with a custom QUIC hole-punching socket. LiveKit may use its own
supported WebRTC transport configuration, but that is the bounded SFU path, not
a new Peer route.

## Primary Sources

- [RFC 8445: Interactive Connectivity Establishment](https://datatracker.ietf.org/doc/html/rfc8445)
- [RFC 5780: NAT Behavior Discovery Using STUN](https://datatracker.ietf.org/doc/html/rfc5780)
- [RFC 8828: WebRTC IP Address Handling Requirements](https://datatracker.ietf.org/doc/html/rfc8828)
- [IETF mDNS ICE candidate design](https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-mdns-ice-candidates-03)
- [W3C WebRTC candidate model](https://www.w3.org/TR/webrtc/)
- [Chromium shared-socket STUN tests](https://webrtc.googlesource.com/src/+/refs/heads/main/p2p/base/stun_port_unittest.cc)
- [coturn listener and auxiliary endpoint reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
- [Cloudflare Realtime STUN service](https://developers.cloudflare.com/realtime/turn/)
- [Tencent Cloud EIPv6 binding API](https://cloud.tencent.com/document/product/215/113678)
