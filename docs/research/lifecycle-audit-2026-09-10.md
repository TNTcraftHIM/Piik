# Lifecycle Ownership Audit

- Reviewed: 2026-09-10
- Candidate baseline: `ebea1c4963e090f7263edd2f3fb7f2593ed1e783`
- Scope: Piik-owned Browser/App orchestration, Server room/route effects,
  media/resource ownership, and interface/release scripts. Upstream dependency
  internals and deferred physical-device matrices are outside this pass.
- Status: in progress; no repair or compatibility claim is made by this record.

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
| Browser Host/Viewer orchestration | In review | `HostPage.tsx`, `ViewerPage.tsx`, App entry, presentation/media adapters; static ownership trace plus focused existing tests |
| Server room/route effects | In review | Room store, route controller, signaling serialization, unlocked password/media work and terminal cleanup |
| Native/media resources | In review | Loopback/control sessions, capture sidecars, WebRTC peers, encoded outputs, SFU routes and relay fanout |
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

## Repair Rule

Only a reproduced or code-proven phase-core failure is repaired in this pass.
The fix must land at the owning boundary and leave one focused check. Larger
media/contract changes, broad compatibility aliases and generic lifecycle
managers require a separate accepted decision.
