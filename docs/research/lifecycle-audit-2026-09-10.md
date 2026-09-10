# Lifecycle Ownership Audit

- Reviewed: 2026-09-10
- Candidate baseline: `ebea1c4963e090f7263edd2f3fb7f2593ed1e783`
- Scope: Piik-owned Browser/App orchestration, Server room/route effects,
  media/resource ownership, and interface/release scripts. Upstream dependency
  internals and deferred physical-device matrices are outside this pass.
- Status: static/automated audit pass complete. Physical mixed-version and
  target-package acceptance remain explicitly pending; no broad compatibility
  claim is made by this record.

## Method

Each area is traced from acquisition through use, commit and retirement. The
review specifically checks A being replaced by B before A completes or cleans
up, failed promises retained beyond evidence, one consumer retiring a shared
resource, cancellation becoming success, and requested/applied settings getting
separate owners. Search hits are leads; a finding requires a reachable caller
and state sequence.

## Coverage

| Area | Status | Evidence and limits |
| --- | --- | --- |
| Browser Host/Viewer orchestration | Static pass complete | Host source/quality/native ownership, Viewer route/media proof/recovery, App discovery and unmount cleanup |
| Server room/route effects | Static pass complete | Room KDF commit/revalidation, route resource release, session guards, shutdown/drain and unlocked password work |
| Native/media resources | Static pass complete | Loopback/control sessions, capture replacement, host/viewer media edges, encoded groups, SFU routes and relay fanout |
| Interface/release contracts | Initial pass complete | Shared protocol/fixtures, descriptive capability metadata, release planning/publishing, update readers and workflow/manual paths |

## Initial Interface/Release Observations

- Release identity is generated from immutable first-parent history and carries
  one product version plus the full source SHA. The local candidate package was
  built with `v1.0.0` and inspected to confirm both values reach the archive,
  embedded Web asset and `REVISION`.
- The publisher verifies all required target descriptors and artifact hashes,
  refuses a tag/release owned by another source revision, resumes only a draft,
  preserves a newer stable release's `latest` state, and never mutates an
  already-published release.
- A resumed same-revision draft can retain an unmatched old asset if the desired
  asset set was changed without changing source identity. Current generated
  names are deterministic for that revision, so no reachable production sequence
  is established; this remains a review note rather than a repair.
- Browser/App update notices distinguish newer version, same-version different
  source SHA, and an official release offered to a development build. The
  Browser request sends no installed identity or credentials.
- Descriptive capability/discovery metadata may omit unknown fields; known
  identity/types remain validated. Commands, credentials and authority-bearing
  messages remain strict. This is implemented at `/api/capabilities` and Native
  discovery, not a blanket JSON policy.

## Confirmed Repair

- A Host quality request made while a live source switch owned the share updated
  the displayed draft but was neither applied nor queued. When the switch
  finished, the visible setting could therefore disagree with the committed
  sender/capture profile. The request is now retained as the existing pending
  quality draft and replayed by the source-switch owner when it releases the
  share. A focused ownership test covers rejection during the switch and commit
  after replay.

## Non-Findings And Evidence

- Host start/stop, room replacement/access waits, App picker preview/start and
  unmount retirement recheck the active generation, share identity, room
  mutation token and current resource reference after awaits. The reviewed
  stale paths either retire only their own resource or leave the replacement
  owner untouched.
- Viewer pending-route activation, active edge failure, decoded-frame proof,
  page suspension and teardown distinguish current and obsolete media bindings.
  A late callback from a discarded Browser or Native peer does not promote its
  stream or connection identity.
- Room password work holds the documented begin/derive/commit sequence. Creation
  rechecks capacity; replacement/password changes recheck pointer identity and
  Host ownership; viewer login rechecks room object, material and live session.
  Route controller results return owned resources for the signaling layer to
  retire; room close waits for exact physical resources and SFU drains.
- Native `updateMu` serializes profile/source replacement. A replacement capture
  is committed atomically, the old stream is retired, and the response waits for
  that exact stream installation or owner cancellation. Native viewer and relay
  consumers retire their own receiver/edge while sharing the control client.
- Browser encoding-pool membership is reference-counted by actual current or
  pending groups. Failure falls back that source to ordinary senders, prune
  disposes unreferenced producers, and pool dispose removes every member before
  pruning. This pass found no cross-source retirement authority.

## Automated Evidence

- Focused Host ownership test: 20 passed after the repair.
- TypeScript typecheck passed.
- `go test ./internal/server/...` passed across app, config, ordered, protocol,
  room, route, SFU, signal, STUN and webassets packages.
- `go test ./internal/app/...` passed across App, browser/launcher/loopback,
  mediaedge, native audio/capture/control/host/viewer, port mapping and tunnel.
- Full deterministic Web check passed after the repair: 53 files, 709 tests,
  production Browser build. `-race` was not run: this Windows host has no C
  compiler in PATH, so Go race detection cannot build.

## Remaining Acceptance

This static pass does not replace the already-owned public-release boundary:
use two real builds with a supported common contract, check stale open pages,
exercise Windows App/Go Server candidates and retained room/config authority,
and rehearse manual release scripts. macOS/Linux physical capture and broad
network/endurance matrices remain deferred as before.

## Repair Rule

Only a reproduced or code-proven phase-core failure is repaired in this pass.
The fix must land at the owning boundary and leave one focused check. Larger
media/contract changes, broad compatibility aliases and generic lifecycle
managers require a separate accepted decision.
