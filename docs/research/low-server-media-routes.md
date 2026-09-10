# Low-Server-Cost Media Routes

- Research date: 2026-08-22; last evidence review: 2026-08-24
- Scope: traffic conservation, SFU cost and ICE isolation, browser NAT limits,
  TURN screening, and bounded SFU admission for one Host and up to twenty authenticated Viewers
- Status: supporting evidence. Current truth is owned by
  [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md), [status](../status.md),
  and [verification status](../verification-status.md).

## Research Conclusion

No topology removes the last-hop media copy delivered to each Viewer. Peer
distribution moves those copies to endpoints; an SFU moves them to a server.
Encoding once may reduce encode work, but it does not repeal network traffic
conservation.

TURN and an SFU solve different problems. TURN relays one ICE transport leg;
an SFU authenticates one publication and emits separately authorized
subscriptions. A relay candidate therefore says nothing about room topology or
whether central distribution is cheaper.

For ordinary browsers, ICE connectivity checks are the reachability authority.
NAT labels, STUN observations, TCP reachability, and guessed ports cannot prove
a usable peer UDP pair. A public SFU may remain reachable over outbound UDP
when peer UDP is not; if all outbound UDP is blocked, a UDP-only media design
must fail clearly unless a separately accepted framework transport exists.

## Traffic Conservation

This is an accounting identity, not a named theorem. Let:

- `N` be the Viewer count;
- `P` be Viewers whose current upstream is a peer edge;
- `S` be Viewers whose current upstream is an SFU subscription, so `N=P+S`;
- `H` be Host-to-Viewer peer edges and `V` Viewer-to-Viewer peer edges, so
  `P=H+V`;
- `B_e` be the measured useful bitrate of peer edge `e`;
- `B_pub` be the total Host-to-SFU publication bitrate across all active
  representations; and
- `B_s` be the selected bitrate of SFU subscription `s`.

Ignoring protocol overhead:

```text
Host upload       = sum(B_e for Host peer edges) + (B_pub when published)
Viewer upload     = sum(B_e for Viewer relay edges)
SFU media ingress = B_pub
SFU media egress  = sum(B_s for subscriptions)
```

For equal-representation bitrate `B`:

| Shape | Host upload | Viewer upload | Central media traffic |
| --- | ---: | ---: | ---: |
| Peer-only | `H*B` | `V*B` | `0` |
| Mixed peer/SFU | `H*B+B_pub` | `V*B` | `B_pub+sum(B_s)` |
| Full-room SFU | `B` | `0` | `(N+1)*B` |

For simulcast, `B_pub` is the sum of representations actually sent. A
`HIGH+LOW` publication can therefore cost more than one same-representation
peer edge. Dynacast or subscriber layer selection changes measured terms, not
the identity.

RTP/RTCP/SRTP, DTLS, ICE, IP headers, retransmission, FEC, and overlap only add
traffic. W3C candidate-pair byte counters omit some overhead, and provider
billing may count interfaces differently. Candidate formulas screen designs;
acceptance uses Host NIC, SFU interface, process, and billing counters from the
same run.

The unavoidable tradeoff is simple: if the server does not emit the copies,
endpoints must. If neither side emits them, the Viewers do not receive media.
Redundancy can improve recovery but adds copies and coordination.

## SFU Cost And Browser ICE Isolation

An SFU has at least four independent cost dimensions:

1. Host publication upload and server ingress (`B_pub`);
2. per-Viewer subscription egress (`sum(B_s)`);
3. packet forwarding, congestion-control, encryption, and room state; and
4. publication/subscription overlap and drain during recovery.

LiveKit's benchmark guidance treats published tracks, subscribers, and bytes
forwarded per subscriber as separate capacity drivers. Published example
numbers are not portable CPU, memory, or bandwidth defaults; instance type,
codec, representation set, bitrate, loss, and concurrency must be measured.

### Pinned Browser Isolation Evidence

One controlled Windows Chrome 151 reproduction used LiveKit Server 1.13.5 and
JS client 2.22.0 while a Mihomo system-stack TUN owned the public default route.
With server-supplied external STUN, two of eight isolated Host publications
connected. With the only changed input
`Room.connect(..., { rtcConfig: { iceServers: [] } })`, eight of eight formed a
nominated non-relay UDP pair. The explicit empty list retained LiveKit's
remotely signaled SFU candidate while suppressing additional Browser STUN
gathering; it did not disable ICE.

The result supports isolating Browser SFU PCs from external ICE servers in that
environment. It does not prove a universal TUN/VPN defect, a candidate-type
contract, fixed Browser socket allocation, mobile behavior, or public-network
success. Ordinary peer PCs and LiveKit server-side public-IP discovery are
separate ICE domains.

Relevant pinned sources are LiveKit's
[join-response construction](https://github.com/livekit/livekit/blob/v1.13.5/pkg/service/roommanager.go),
the client [connect options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts)
and [RTC configuration merge](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/RTCEngine.ts),
plus [media-transport public-IP discovery](https://github.com/livekit/mediatransportutil/blob/a3417d38cda0/pkg/rtcconfig/ip.go).

## Hard NAT And UDP Boundaries

"Symmetric NAT" is imprecise shorthand. Relevant facts are mapping and
filtering dependence, outbound UDP reachability, address-family support, state
lifetime, and network changes. CGNAT is an operator topology, not one behavior;
RFC 6888 inherits UDP NAT behavior requirements and recommends
endpoint-independent filtering.

| Condition | Standards boundary |
| --- | --- |
| Endpoint-independent mapping/filtering with UDP | Full ICE can test host, server-reflexive, and peer-reflexive pairs. |
| One endpoint-dependent mapper | Coordinated checks may work, but success is not guaranteed. |
| Two endpoint-dependent peer mappers | Direct peer UDP is not generally reliable; a public UDP service may still be reachable. |
| All outbound UDP blocked | No UDP candidate can carry media. |
| Wi-Fi/cellular/address change | Old mappings may be invalid; a fresh generation and bounded ICE rebuild must re-establish facts. |

Peer-reflexive candidates appear only after a connectivity check succeeds. RFC
5128 limits port prediction to favorable behavior; randomized or multi-level
mappings defeat it. RFC 5780 observes behavior toward its STUN destinations and
does not replace ICE. Carrier, CGNAT, UA, and candidate-type labels must not be
turned into success probabilities.

Ordinary browser JavaScript cannot bind raw UDP source ports, perform broad
multi-socket birthday probing, control PCP/NAT-PMP/UPnP gateways, or implement
TCP simultaneous-open. Creating many `RTCPeerConnection` instances would add
ICE/DTLS work, sockets, memory, and abuse surface without granting that control.
ICE renomination and QUIC traversal drafts do not expose a current browser API
that changes this boundary.

Native libp2p, Tailscale, and mobile studies are useful operational evidence,
but their relay reservation, raw-socket control, address discovery, native
coordination, and sampled networks differ from browser WebRTC. Their success
rates are not Piik coverage estimates.

## TURN Screening And No-Go

RFC 8656 TURN creates an allocation and relays packets for one client transport.
It does not authenticate or distribute a room publication. Gathering TURN
candidates participant-wide allocates server state even when the candidate is
never selected and widens credential scope beyond the exact route demand.

A later exact-edge TURN candidate narrows that scope but still adds a third
application candidate with separate credential issuance, allocation admission,
endpoint rebuild, recovery, expiry, and failure ownership. The functional
ability to relay one edge did not prove a need beyond the existing bounded SFU
fallback, so neither candidate is retained as a product route.

The useful-payload cost comparison explains the pressure. For `K` Host-to-
Viewer edges that all require TURN at bitrate `B`:

```text
TURN edges: Host K*B; TURN ingress K*B; TURN egress K*B
SFU:        Host B;   SFU ingress B;    SFU egress K*B
```

At `K=1`, both central paths carry `2B`, so traffic alone chooses neither. At
`K=2`, TURN carries `4B` centrally while a same-representation SFU carries
`3B`; TURN also preserves two Host sender pipelines. Mixed representations use
measured `B_pub` and `sum(B_s)`, so the SFU advantage is not assumed.

This no-go is an application-scope decision, not a claim that TURN is broken.
Coturn remains a valid BSD-3-Clause STUN/TURN implementation, and LiveKit
supports TCP and embedded/external TURN options. Framework capability alone
does not require enabling every transport in Piik.

## SFU Admission Evidence

LiveKit controls do not directly express Piik's resource dimensions:

- room `maxParticipants` limits participant count;
- `canPublishSources` is an authorization allowlist;
- `limit.num_tracks` gates node-wide incoming plus outgoing tracks; and
- participant subscription limits cap subscribed track counts and may leave
  excess requests pending.

None is a Host-publication ingress budget, per-subscription egress budget, or
bandwidth/CPU guarantee. Application admission therefore needs distinct typed
publication and subscription demand, sized from the accepted codec,
representations, bitrate, instance, and concurrency evidence.

Admission must cover reservation, commitment, overlap, and drain. A token or
participant disconnect is not release proof: `RemoveParticipant` closes the
current participant but does not revoke an otherwise valid join token, and
token expiry controls new admission rather than terminating existing media.

For a dedicated self-hosted namespace, disabling `room.auto_create`, creating
an unguessable generation room explicitly, and retaining charges until
`DeleteRoom` succeeds and a follow-up lookup proves absence closes stale-token
re-entry. A single application process can own local counters; multiple
application processes require shared atomic admission before claiming a
deployment-wide bound.

The minimum capacity experiment measures one publication with 1, 2, and 20
subscriptions on the same SFU host and NIC. It records CPU time, RSS, ingress,
egress, packets, forwarding latency, loss/recovery, and decoded quality at the
actual representation/bitrate matrix. It also exercises reservation overlap,
failed creation, deletion-plus-absence, and process restart. Synthetic room or
track limits alone are not capacity evidence.

## Security And Privacy Boundary

TURN and SFU credentials must be short-lived, role- and generation-scoped, and
kept out of URLs, logs, diagnostics, and durable storage. Raw SDP, ICE
candidates, addresses, ports, tokens, and device identifiers are not needed for
route or capacity acceptance.

Direct peer media is endpoint-to-endpoint DTLS-SRTP. Ordinary SFU media
terminates DTLS-SRTP at the SFU, so the operator can access media unless an
application E2EE design and key-distribution mechanism is separately accepted.
This trust distinction is independent of traffic cost.

## Primary Sources And License Boundary

Sources were checked from 2026-08-19 through 2026-08-24:

- [RTP Topologies, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html),
  [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html), and
  [WebRTC transports, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html).
- [UDP NAT behavior, RFC 4787](https://www.rfc-editor.org/rfc/rfc4787.html),
  [P2P across NATs, RFC 5128](https://www.rfc-editor.org/rfc/rfc5128.html),
  [NAT discovery, RFC 5780](https://www.rfc-editor.org/rfc/rfc5780.html), and
  [CGN requirements, RFC 6888](https://www.rfc-editor.org/rfc/rfc6888.html).
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html) and
  [coturn 4.17.2 documentation](https://github.com/coturn/coturn/blob/4.17.2/README.turnserver)
  (BSD-3-Clause; no code copied).
- [WebRTC](https://www.w3.org/TR/webrtc/) and
  [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/).
- [LiveKit Server 1.13.5 configuration](https://github.com/livekit/livekit/blob/v1.13.5/config-sample.yaml),
  [track-limit selection](https://github.com/livekit/livekit/blob/v1.13.5/pkg/routing/selector/utils.go),
  [publication checks](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/participant.go),
  [subscription limits](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/subscriptionmanager.go),
  and [RoomService lifecycle](https://github.com/livekit/livekit/blob/v1.13.5/pkg/service/roomservice.go).
- LiveKit official [tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/),
  [RoomService API](https://docs.livekit.io/reference/other/roomservice-api/),
  [ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/),
  [deployment](https://docs.livekit.io/transport/self-hosting/deployment/),
  [benchmark guidance](https://docs.livekit.io/transport/self-hosting/benchmark/),
  [selective subscription](https://docs.livekit.io/transport/media/subscribe/),
  and [E2EE](https://docs.livekit.io/transport/encryption/).
- [LiveKit JS client 2.22.0](https://github.com/livekit/client-sdk-js/tree/v2.22.0)
  and [LiveKit Server](https://github.com/livekit/livekit) are Apache-2.0; their
  APIs and source behavior were inspected without copying code.
- [Mihomo TUN configuration](https://wiki.metacubex.one/config/inbound/tun/),
  [libp2p hole punching](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md),
  [ProbeLab's DCUtR report](https://github.com/probe-lab/dcutr-project/blob/main/docs/dcutr-final-report.md),
  and the [2023 CGNAT/mobile study](https://arxiv.org/abs/2311.04658) bound the
  operational observations; none supplies a browser success-rate guarantee.

IETF and W3C specifications and published papers are design references, not
implementation licenses. No GPL/AGPL code was copied.
