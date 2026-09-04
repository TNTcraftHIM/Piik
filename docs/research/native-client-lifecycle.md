# Native Client Lifecycle

- Reviewed: 2026-09-04
- Scope: Windows capture idle semantics, native loopback input isolation, and
  Browser visibility of an unexpected Client disconnect.
- Status: code fix complete; the current Windows static-source and Client-crash
  gates pass; cross-version behavior remains physical acceptance work; no new
  wire version.

## Current Evidence

1. The Windows capture loop waits up to five seconds for `FrameArrived` and
   fails the capture on `WAIT_TIMEOUT`. The source and target-closed events are
   already separate signals. Whether an unchanged WGC source stops producing
   frames on supported Windows builds is a physical question; the repository
   has no static-source gate. The correct invariant is that an idle source is
   not itself a capture-end signal. A new Viewer may still need a keyframe from
   the latest retained image.
2. Native control validates message shape and bounds, but a Pion error from one
   edge candidate or answer currently returns from the extension handler. The
   loopback server treats any extension error as a control-protocol failure and
   closes the session. Per-edge media input must not terminate unrelated edges;
   malformed candidates are disposable input, while a missing/closed edge stays
   a lifecycle result.
3. `NativeClient` rejects pending requests and clears listeners when its socket
   closes unexpectedly, but emits no close notification. The Host therefore
   waits for the bridge or ICE state to expose a dead Client. The control socket
   is the native share owner's authority, so an unexpected close should notify
   that owner; an intentional `close()` must remain silent.

## Scope Decisions

- Keep one strict loopback wire and one-share/one-session fence.
- Do not change room, route, SFU, codec, NAT, or browser-only behavior.
- Do not add a tunnel watchdog, local-process authentication scheme, custom
  quality score, or compatibility alias in this phase.

The loopback identifier boundary is now aligned at 8-256 bytes, and the link
gate is included in TypeScript checking. Evidence wording distinguishes scripted
package gates from physical-device gates. The possible cloudflared orphan and
the intentionally per-user local trust boundary remain separate decisions; no
runtime change for either is claimed here.

## Implemented Boundary

- Windows capture treats a quiet frame pool as idle. It retains one latest
  converted frame and emits it only when an explicit recovery keyframe request
  arrives; source-close and target-process signals remain the end conditions.
- Native Pion candidate input is syntax-checked with the existing ICE parser,
  bounded before queuing, and discarded when malformed, stale, or over capacity.
  Repeated answers for an edge are idempotent. Profile updates remain fenced to
  that same share session in the current loopback v7 wire.
- An unexpected Browser control-socket close now notifies the active Host owner;
  intentional user cleanup remains silent and uses the existing share fence.

## Physical Evidence

- On 2026-09-04, a blank Windows Notepad window was selected as a native source.
  The capture process stayed alive beyond seven seconds without a new source
  change, grew from 7,664 to 16,095 output bytes after a `K` request, and then
  exited cleanly. This validates the quiet-source and retained-frame path on the
  current Windows host; it does not claim a cross-version Windows matrix.
- The same day, the local Native Host gate started a real Host/Viewer share,
  terminated the Client process, and observed the Host return to its start-share
  control within the bounded gate. Browser, capture, server, ports, and profile
  cleanup all passed.

## Acceptance

- Static Windows source remains a live share for a bounded physical run, and a
  new Viewer can obtain a keyframe without a source change.
- A malformed/stale ICE candidate or repeated per-edge answer does not close the
  control session or terminate sibling edges; a real edge lifecycle failure
  remains observable.
- Killing the Client causes the active Host owner to leave the native share
  path promptly, while ordinary user-initiated cleanup does not recurse.
- `npm run check` and the relevant Client checks pass; no credentials or raw
  media identifiers enter logs or documentation.

Cross-version capture and browser matrices remain separate acceptance work. They
are not claimed by the current Windows gate.
