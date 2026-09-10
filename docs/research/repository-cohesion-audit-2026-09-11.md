# Repository Cohesion Audit

- Started: 2026-09-11
- Candidate baseline: `fe199cf4`
- Scope: Piik-owned source, tests, scripts, workflows and durable documentation.
  Third-party implementation internals and deferred physical-device matrices are
  outside this audit.
- Status: in progress.

## Audit Questions

1. Does each module own one coherent responsibility, or is orchestration,
   policy, presentation, I/O or resource retirement mixed across boundaries?
2. Are permission, capability, readiness, requested settings, applied settings,
   observation and terminal failure represented as distinct facts?
3. Do TypeScript, Go, UI copy, configuration, package metadata and documents use
   the same name for the same concept and different names for different facts?
4. Are dependencies one-directional and explicit? Are there cycles, hidden
   globals, duplicate truth, reverse layer calls or speculative wrappers?
5. Is each test/gate/script tied to a real contract or failure mode, or only to
   current implementation details?
6. Can a smaller ownership boundary or deletion produce the same verified
   behavior without reducing viewing quality, accessibility or recoverability?

## Method

Start from the current source and documented owners, not old branches or chat
summaries. Build an import/call map, trace representative end-to-end flows, and
inspect each candidate with its callers. A finding requires a concrete sequence
or maintained duplicate owner. Search hits, line count and subjective style are
leads only.

Compare non-obvious practices with primary sources from mature projects. Consult
those sources for design rationale only; do not copy implementation code or add
a dependency without a separate accepted decision.

## Coverage Matrix

| Area | Status | Findings |
| --- | --- | --- |
| Browser UI orchestration and state projection | Pending |  |
| Browser media/WebRTC/native adapters | Pending |  |
| Go room authority and persistence | Pending |  |
| Go signaling and route effects | Pending |  |
| Native App control/capture/mediaedge | Pending |  |
| Protocol, HTTP, configuration and release contracts | Pending |  |
| Tests, gates, packaging, workflows | Pending |  |
| Documentation and public copy ownership | Pending |  |

## Finding Classification

- **Confirmed defect:** reachable incorrect behavior or a maintained contract
  mismatch. Repair in this phase when small and phase-core.
- **High-confidence improvement:** clear ownership/simplicity gain with bounded
  risk; may be repaired or scheduled explicitly.
- **Tradeoff:** materially changes architecture, compatibility, operations or
  product behavior; requires owner decision.
- **Unproven lead:** needs a reproduction or measurements; take no action now.

## Running Verification

No final verification claim is made until the audit closes. Record exact checks,
their scope and known limits here.
