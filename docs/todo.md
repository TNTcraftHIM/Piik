# Current TODO Ledger

Last reviewed: 2026-09-12

Only **Now** is executable. Product modules own behavior; Git/PRs own completed
history. A parked idea is not implementation authority.

## Now

- [ ] **Post-launch monitoring.** Collect App/Server feedback and verify the
  public download path after product releases. Preserve the owner's
  [device/network deferrals](./verification-status.md#candidate-evidence-boundary).

Keep fixes on a maintenance branch until acceptance. The public release is the
compatibility baseline; private service deployment stays independent.

## Next: P2P Connection And Feedback Review

After the current phase, measure connection success, time to first picture and
failure causes on representative networks, especially App and P2P-only sites.
Review user progress/failure feedback and useful privacy-conscious diagnostics.
Trace the existing ICE and P2P/SFU handoffs, including background P2P attempts
behind working SFU media; compare SFU-first startup with measured current behavior
before choosing changes. Preserve one graph and one operation under the
[routing contract](./product/routing-transport.md) and
[ADR-0005](./adr/0005-automatic-hybrid-media-routing.md). Prior ownership audits do
not establish better connection success or speed; this note adds no retry policy.

## Parked Product Work

The reported persistent low resolution after Viewer backgrounding and square
black video remain unconfirmed incident leads, separate from the closed,
reproduced reconnect ownership bug. They do not block this release. Reopen from
matching upstream/receiver evidence; local H264 relay background checks did not
reproduce them. Missing NAT attempt text alone does not prove skipped attempts.
If Native adaptation is implicated, compare actual VSE limitations with sender
quality evidence before changing policy. Do not add retry budgets, visibility
resets or resolution heuristics without proof. Sanitized aggregates and the
isolated reconnect reproductions are diagnostic evidence, not a recovery policy.
Game/background settings behavior also remains an unconfirmed incident lead;
reopen from actual control actions and matching requested/applied media evidence.
Clarify whether Viewer-local pause should survive replacement media before
adding playback-intent state; the current binding starts new media unless the
Host is paused. No preservation policy has been accepted for that transition.

1. **Representative device/network acceptance.** Resume the remaining matrix in
   [verification status](./verification-status.md#remaining-device-and-network-acceptance)
   when directed, preserving the owner's platform deferrals. Correlate freezes
   with publisher/receiver evidence before changing media policy. Run physical
   workloads serially from stable executable paths with cleanup between runs.
2. **Broader quality work.** Reopen from measured benefit at acceptable complexity.
   Preserve chosen profiles, bitrate ceilings, endpoint capacity and P2P-first
   routing unless a new accepted decision supports changing them. No weighted
   score, all-pairs probes, periodic rebalancing, parent-wide prediction or
   room-wide minimum. Check whether a quality move merely shifts pressure to
   another parent's siblings before widening policy.
3. **Control/resource fairness and input review.** Reassess the authenticated
   WebSocket/SFU owner, HTTP/body/resource bounds, authorization and error/log
   handling before adding a queue or limiter. No parallel security framework,
   accounts, risk score or speculative policy layer.
   Measure signaling-lock contention and synchronous diagnostic I/O before
   changing the lock or execution model; their cost remains a tradeoff.
4. **Reachable ownership/refactor work.** Retain Host/Viewer page media-session
   extraction as a candidate alongside related behavior changes. Evaluate clear
   resource owners, fewer shared writers and a smaller change surface under
   [engineering review](./reference/engineering.md#ablation-and-review); file
   size alone does not justify a split. The completed audits do not close this
   candidate. Reopen C=3 structural-intent retention, SFU failure during unrelated
   prepare and multi-child evidence ownership only with current-contract
   reproductions.
   No new revision namespace, failure-state mirror or topology queue by default.
5. **Storage fault recovery.** Choose and verify a damaged-disk/COMMIT/ROLLBACK
   recovery policy before adding catch-and-continue or retries. This failure
   boundary remains unestablished after ordinary persistence checks.
6. **Platform output.** Reopen for a registered receiver acting as an ordinary
   Viewer only after the [platform-output gate](./research/platform-output.md)
   passes.
7. **Full UI themes.** After the base version, research themes that can change
   layout, composition and motion, including a restrained graphic/cinematic
   direction with original Piik assets. Assess extension boundaries and cost
   before scheduling any theme/plugin API. Design experiments remain in Git
   history, outside the main source tree.
8. **Visual presentation and community translations.** In a later version,
   explore bringing the pure-visual mode's illustrations and motion into the
   Chinese and English interfaces. Evaluate whether a separate pure-visual mode
   remains useful, and prepare the existing locale catalogs for community
   translations. No removal or new translation framework is scheduled for this
   release.
9. **Website illustration polish.** Match the Host's held prop to the four
   existing hero activities: gamepad, paintbrush, camera and remote. Keep the
   accepted bright cast, floating hands and shared activity timing.
