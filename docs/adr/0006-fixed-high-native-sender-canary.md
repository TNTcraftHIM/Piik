# ADR-0006: Fixed-HIGH Native Sender Canary

- Status: Proposed - Product Gate No-Go
- Date: 2026-08-19

## Context

The Draft #16/#18/#22/#23/#25/#28 ladder proved isolated WebCodecs/Pion
properties, not integration with Screener's current rooms, signaling, ordinary
browser viewers, or per-edge ICE transport. A native sender remains a later
optimization and must not be presented as available product behavior.

## Retained Boundary

Any renewed product-wiring canary stays deliberately narrow:

- one fixed VP8 `HIGH` representation at 1280x720, 30 fps, and a 3 Mbps ceiling;
- one WebCodecs encoder object feeding at most two independent Pion WebRTC legs;
- the current strict ordinary-P2P signaling wire and unmodified browser viewers;
- independent STUN-backed ICE, RTP/RTCP, congestion, and lifecycle state per leg;
- read-only feedback, with PLI/FIR limited to requesting a shared keyframe; and
- bounded local queues, fail-closed critical errors, and sanitized local-only
  diagnostics.

This canary excludes room-wide minimum feedback, automatic quality control,
`LOW`, viewer C reporting, peer-assisted/SFU routing, audio, packaging, and any
claim of one physical or hardware encoder. A third viewer must never create a
third host edge. The missing audio path remains a product-acceptance gap.

## 2026-08-19 Gate Result

The sole authorized run is `no-go-unclassified`; the retained evidence and
probe limitations are recorded in the native sender research. The earliest
missing checkpoint is viewer authentication, not a proven authentication
failure. No viewer-1 acceptance means there is no two-viewer, third-viewer
FIFO, or direct/SFU proof. The attempted native branch must not be opened or
merged as product code from this state.

## 2026-08-20 Historical Wire Checkpoint

This checkpoint targeted the then-current `screener-v2` wire and SQLite schema
v2. It is experiment provenance, not a current integration contract; current
source and production boundaries are owned by [status](../status.md), and
executable senders remain outside the current release.

A clean local delivery candidate now targets only `screener-v2`: it exchanges
`SITE_ACCESS_PASSWORD` for the bounded HttpOnly site-access cookie, uses
that cookie to create an explicit `private-link` room, carries it on the Host
WebSocket upgrade, and strictly decodes the current ordinary authenticated and
read-only Viewer-evidence shapes. There is no v1 parser, translator, raw-grant
persistence, or Bearer room-creation shortcut. Its fixed 300-second provisional
request always creates a random transient room in memory, even when SQLite is
configured. A connected current Host suppresses that reclaim deadline; only its
generation-matched disconnect resets the five-minute window, while the ordinary
transient `ROOM_TTL_SECONDS` cap always remains. A pre-auth connection or
authentication failure gets one retry with the same room/token/client generation
and never another room POST. Server restart drops the room; SQLite stays at v2
and ordinary Web rooms are unchanged. No claim-confirm message, durable native token, or recovery
subsystem is added. Focused Go/TypeScript tests and static checks pass. The unused
generic probe framework is deliberately not retained. A current command consumer
may keep only the minimum stage ledger needed by the next authorized run.

The first authorized current-wire run on 2026-08-20 remains
`no-go-unclassified`. It used Windows amd64, Chrome 151, one real animated Chrome
tab, and an isolated local Node server with an in-memory RoomStore and peer
assistance disabled. Safe Chrome history booleans prove that the source and
Sender pages loaded and that no Viewer page was created. The runner stopped
after a bounded 20-second Sender-start interval without observing the combined
Sender-ready and Go source-RTP condition.

The timeout path failed to preserve its final Sender DOM/counter sample. It
therefore cannot distinguish capture selection, site access/create, WSS
authentication, local bridge, first encoded output, or Go ingest as the first
runtime break. None is a proven product failure. No retry, timeout adjustment,
Viewer, second Viewer, or FIFO run followed. A separately authorized rerun must
first make the stage-1 ledger unconditional and prove that timeout retains the
last sanitized checkpoint; only a passed Sender/source-RTP stage may create the
single Viewer. The product gate remains no-go and this local branch is not a
product availability claim.

The retained current command consumer appends and flushes only monotonic,
sanitized Sender-start fields. Its static one-Viewer gate now freezes one
socket/auth/connection/PeerConnection/video-track generation and the matching
Pion slot/edge generation, then revalidates that identity during media progress;
raw connection IDs never leave the page probe. Every CDP RPC and sample shares
its enclosing absolute deadline. `passed` is impossible until bounded Chrome
and native process-tree exit, listener closure, and audited deletion of the
exact task profile under system Temp all succeed; a reparse point or deletion
failure is a fixed cleanup failure. Pure checks cover retained timeout evidence,
hung samples, cross-generation rejection, cleanup-before-pass, and profile
cleanup failure.

One separately authorized second run then used that frozen gate with the same
bounded local topology. Its retained ledger proves `getDisplayMedia` request and
resolution, site access and room creation, Host WSS authentication, local
bridge readiness and fixed-`HIGH` config acceptance, exactly one encoder object,
and entry into the first WebCodecs output callback. It serialized zero media
counters without retaining whether any diagnostics arrived, so those values do
not prove that Go reported zero. It stopped at `sender-start` and never created
a Viewer. No retry or threshold adjustment followed. Cleanup completed before
final failure: Chrome and Native exited, the
Node server and all three loopback ports closed, and the exact task Chrome
profile passed the non-reparse audit and was removed.

This remains `no-go-unclassified`. The frozen probe counted the first encoded
chunk before invoking the product output callback and did not record whether the
generation-bound local bridge attempted, returned from, or threw during its
binary send. Static inspection finds matching 17-byte big-endian frame contracts
on the Web and Go sides. A focused integration now configures the real `/media`
handler, sends one same-contract binary frame, and observes positive Go frame and
source-RTP accounting. That proves the current envelope can enter the current Go
fanout in a controlled test, not that the retained browser executed its send.

The handler no longer returns silently for every post-config bridge read error:
while the app context is active, any close other than normal or going-away emits
one `fatal` with the fixed sanitized message `local media bridge read failed`.
Focused tests prove the abnormal classification without its underlying close
reason and prove normal close and app shutdown do not misreport. This is a real
P1 bridge-read failure fix, but it does not classify the missing diagnostics
or prove a framing defect.

One authorized evidence-clarification revalidation then ran the corrected gate
exactly once with the same fixed VP8 `HIGH`, Chrome 151, one in-memory local room,
and peer assistance disabled. It retained the same start sequence through one
generation-1 binary send return, then observed no diagnostics or post-send
diagnostics, zero encoder errors, and at least one sanitized fatal marker. Its
media-counter zeros are initial ledger values, not Go reports. The first failed stage remained
`sender-start`, no Viewer was created, and cleanup passed 5/5. No retry,
threshold change, H.264, second Viewer, FIFO, or production run followed.

The result remains `no-go-unclassified`. It proves the first product binary
send returned, but the retained fatal marker and missing diagnostics do not prove
where or why the product path stopped. No raw cause may be inferred. There is
still no Viewer, two-viewer, FIFO, or physical or hardware-encoder proof.

A source follow-up identifies and removes one concrete fatal path without relabeling
that retained run. WebCodecs output duration is nullable; the local sender uses
33,333 microseconds when it is absent, while a valid next capture timestamp may
arrive slightly earlier. The prior RTP timeline rejected that strictly
increasing pair as `encoded frame timestamps overlap`. The candidate now derives
RTP cadence from adjacent strictly increasing source timestamps and uses duration
only to report positive source gaps. Focused tests retain dropped-frame timing,
non-increasing rejection, and sub-sample progress; the real `/media` handler also
accepts two frames at 1,000,000 and 1,033,000 microseconds when the first reports
33,333 microseconds. This proves the source path no longer raises that fatal, not
that it caused the retained browser failure.

## 2026-08-20 One-Viewer Loopback Revalidation

A bounded Chrome 151 run with fixed VP8 1280x720@30 and peer assistance disabled
closed the base sender-to-Viewer path once. Sender/Go recorded 30 written frames,
85 source RTP packets, and zero fatal or encoder errors. The Viewer authenticated,
completed offer/answer/ICE, received 877 packets, and advanced from 0 to 299
decoded and rendered frames at 1280x720. The probe was corrected to tolerate
pre-offer trickle candidates and a development-only pre-offer control-socket
replacement while retaining fail-closed checks after an active offer/PC.

The run still ended negative at the gate's Pion outbound assertion because the
two-second Go diagnostics snapshot did not refresh during the media sample
(`pionPacketDelta=0`). This is a residual observation-timing gap; inbound packet,
decode, render, source-RTP, and no-fatal evidence are retained. The result is
therefore a one-Viewer functional loopback proof, not a broad Native acceptance:
two edges, FIFO, hardware, endurance, public-network, audio, and packaged-native
boundaries remain no-go.

## Staged Revalidation

Any further run requires separate authorization and must stop at the first
failed stage while synchronously retaining a bounded final-negative snapshot:

1. Prove host room/auth, local config acknowledgement, one encoder object,
   bridge ingress, frame decode, source RTP, and zero critical errors.
2. Prove viewer auth, `peer-joined`, exact offer/answer/candidate exchange, and
   both PeerConnection state timelines.
3. Prove one viewer's inbound packets, `framesDecoded`, video readiness/current
   time/dimensions, and rendered frames.
4. Add viewer 2 and prove two independent legs while encoder instances stay one
   and host media edges stay at most two.
5. Add viewer 3, prove no third edge and a host-side waiting observation while
   the viewer keeps its existing waiting state, then close viewer 1 and prove
   FIFO promotion plus decoding/rendering.
6. Keep this candidate STUN-only. Direct failure remains inside ADR-0005's
   dedicated Host-publication/SFU-subscription boundary; the Native canary does
   not add another media transport or widen that route model.

A commit-bound, short-lived evaluation artifact may package the current source
to run these stages without a development toolchain. That artifact is not an
acceptance or release claim. Only after these stages pass may separate
performance, quality, loss, reconnect, browser, audio/A-V-sync, formal release,
and license gates begin. Do not expand the feature to make the diagnostic gate
pass.

## Consequences

ADR-0006 records a bounded candidate and its failed first product gate, not an
accepted architecture or shipped sender. The deployed Web sender and ordinary
viewer remain unchanged. ADR-0007 continues to own path-isolated
`HIGH + at most one LOW`; this canary cannot advance or replace it.

## References

- `docs/research/native-shared-encode-sender.md`
- `docs/adr/0007-demand-driven-dual-representation-quality.md`
- `docs/research/browser-screen-audio-quality.md`
