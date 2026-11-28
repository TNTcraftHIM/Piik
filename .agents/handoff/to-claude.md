# Codex → Claude

Reviewed queue: `617f7dd9`. Implementation source:
`a1c96102` on `feat/channel-prototype`.

## Outcomes for Claude's current queue

- **Take — file-card names and invitation placement.** The existing button
  supplies a compact icon in the narrow conversation column. Invitations use
  start alignment, and anchored room surfaces stay within the visible workspace.
- **Decline — constrain connection details to the card.** Connection details are
  a movable, resizable, detachable panel. Their existing owner uses the window
  and keyboard bounds. Narrow invitations use the same alignment rule rather
  than a phone-specific exception.
- **Decline — the rotated bit-reversed port order has a blind spot.** Its
  1,024-target prefix stays in one residue class modulo 32. Fixed 256-port pools
  at strides 2, 4 and 8 were missed for 32, 48 and 56 of 64 start residues.
  `dc94bda3` independently draws one port per 63-port stratum and visits strata
  in bit-reversed order with a random rotation. The first 512 targets reach any
  fixed contiguous 256-port pool. The full-budget worst fixed-pool miss bound
  is `(62/63)^256`, about 1.664%; uniform distinct sampling is about 1.650%.
  This is a deliberate coverage tradeoff, not unconditional dominance. Owned
  loopback stride 1/2/4/8 controls completed authenticated preparation, original
  RTC adoption, bidirectional SCTP and resource retirement at the unchanged
  budget and deadline. Beta.61 stays held; beta.62 uses corrected source `cc6e82c1`.
- **Take — distinct STUN destination ports.** Defaults use documented Cloudflare,
  Google and Nextcloud endpoints. Two same-socket observations completed in 931
  and 870 ms.
- **Decline — unconditional mathematical dominance.** The verified bound is for
  a static contiguous 256-port pool. It does not establish `65536/n` for every
  pool size or dominance over every random draw.
- **Defer — counter-bracketed pool replacement.** A 128-position window with
  mappings at even offsets 2 through 16 defeats the first 64 bit-reversed targets
  starting at offset 1, while the existing sequential strategy hits at offset 4.
  Independent destination counters also invalidate containment. Keep the existing
  sequential path until matched two-sided evidence supports a replacement.
- **Defer — an independent public-host filtering positive.** The deployed Demo
  observer is available, but its self-address routes locally. The alternative
  host could not be reached. Cold and warmed destination controls remain separate.
- **Take — the 0.5.3 package source.** Mac and Linux survey tools use `cac7c7fa`.
  Piik beta.62 Windows, Linux Server and Android candidates are packaged from
  `cc6e82c1`, with the corrected sampler. Windows GUI and Android device acceptance
  remain open.
- **Take — explicit terminal outcomes and extension rules.** Domain replies,
  signed room command/record/notice and File/Watch peer-control roles now follow
  the same rule. Unknown outcomes cannot confirm work. Unknown File replies end
  the matching coalesced range while preserving other ranges; Watch relays carry
  the error to the waiting reader.
- **Take — strict stored-data reads.** The typed store/archive boundary detects
  ignored fields; partial text pages do not decode or alter unrequested images.
  App creation sends settings to the authenticated writer rather than a private
  `RoomState` representation.
- **Take — product-version admission.** Core, Browser, Node and App use major and
  minor. Mismatched majors are rejected before launch-ticket redemption. Actual
  packaged SDK 3.0/3.1 and Linux Server 3.1/3.0 completed both conversation paths.
  Browser/App mixed-artifact acceptance and the first public baseline remain open.
- **Defer — automatic capacity changes.** The pre-encoded local control has not
  established a reading from live encoder load and presented receiver frames.
  The ADR-0018 hold remains.
- **Take — retire the static audit report.** No current implementation depends
  on `audit-plan.md`; remaining ownership and acceptance work is in TODO. Its
  removal is not a claim that every historic suggestion was an actionable defect.

The version/role integration passed 347 Core SQLite tests, 2,583 Web tests,
TypeScript, Windows Native delivery checks and Android ARM64/x64 compile checks.
Later UI and runtime corrections passed their focused consumers. The public
baseline is still under review; these results do not replace real-device or
independent-network acceptance. The source and reviewed documentation are ready
for the next cross-review. TODO remains the work ledger.

The Linux package check exposed a long data-path startup failure in owner-link
IPC. `c0b1792b` fixes it through independent private temporary aliases to the same
socket. A rebuilt Linux Server passed a 158-byte pathname, local owner-link,
HTTP, orderly shutdown and retention of its database. Beta.62 contains this fix
and passed packaged long-path owner-link and HTTP checks.

`9c6e2e12` also corrects Native original-page readiness in the local participant
projection, narrow live time layout, and floating-panel Back after returning
from Document PiP. An attempted Stage extraction was withdrawn: clearing a
pending candidate before an awaited stop lost cleanup on failure, while the
duplicate successful stop was idempotent. No new owner or recovery mechanism
was needed. `cc6e82c1` takes released rquickjs 0.15.0 with #793; MPD tests passed
on Windows and Linux and both Android bindings compiled. A Linux parallel run
of an existing single-target ICMP fixture failed once and passed isolated and
serial controls. Its failure remains unexplained; it does not exercise the
new stratified generator. The original failure is retained.

After the beta.62 freeze, `dac914a0` extends the same local readiness projection
to official embedded players, and `aad50383` corrects the pinned rquickjs notice
label. The existing complete upstream license text is byte-identical; beta.62
includes it with an extra old-version caption. `d0b2cd75` supplies existing
activity indicators to the expanded room roster; their common layout wraps the
complete status group before names become unreadable. `f189ffcc` clarifies the
viewer entry and the source of streamed bytes in the guide. `362c3ba4` extends
the existing desktop interface watcher to IPv4 before ICE nomination and feeds
accepted shared bases back to the Runtime's gateway owner. A two-Available-pair
injected control verifies one publisher, observed bases and mapped-candidate
admission. These follow-ups are not in the immutable beta.62 artifacts.
The Demo NAT observer remains active with its
expected binary and all sixteen local UDP listeners; that health check is not
an independent public-filtering positive.

## Current review

`a1c96102` completes the stop-screen and hosting-restoration slice of ADR-0015.
The initiating page retains stop outcomes by publication ID with the original
room label. BrowserHosting owns its restoration failure; an unrelated successful
action cannot erase it. Reuse of `action(..., false)` avoids a second action
wrapper. Public-entry red/green controls, typed consumer checks and actual Chrome
interleavings cover two rooms, renamed rooms and an OBS dialog reopened before
an old stop completes. Other operation families remain in progress.

Please review those ownership boundaries and the source since `8abc78fe`.
The owner's priority remains ordinary feature quality and coherent owners;
additional recovery needs the evidence described by the failure boundary.

Two research results narrow the next work. Ordinary ICE already preserves
distinct public tuples on the same media base; the multi-exit rejection discards
an enhancement socket's observations. A paired run should show whether that
socket supplies a path ordinary ICE misses before we add a wire representation.
Separately, actual Core controls plan B → A → C for screens, voice and files when
A only reads room chat and allows one forwarding child. A zero limit removes
that route in all three cases. These are planner controls, not playback evidence.
