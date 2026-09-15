---
name: context-consistency
description: >
  Review repeated meanings across Piik code, UI, copy, lifecycle and documentation.
  Use for cross-surface or cross-layer consistency work, recurring fixes in sibling
  paths, and requested repository-wide standardization audits. Locate common
  ownership gaps while preserving differences justified by context.
---

# Context Consistency

Apply the project's [contextual contract](../../../docs/standards/engineering.md#contextual-consistency).
[AGENTS.md](../../../AGENTS.md) owns authority and
[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns delivery. This skill is a review
method, not a second product specification or permission to change behavior.

## Scope And Sources

Read the user's latest accepted decisions and the relevant entries in the
[owner map](../../../docs/standards/documentation.md#owners). Follow their product, design,
engineering or operational owners; do not load every reference for a scoped fix.
Treat desired rules, current implementation and verified behavior separately.
An undocumented preference or an old audit is not an accepted contract.

For a scoped change, follow the affected semantic family and its actual callers.
For a requested repository-wide audit, first inventory standards and reachable
surfaces across Browser/App/Server, shared interfaces, website/demos, tooling
and guides. Record examined and unexamined areas so a large finding count cannot
stand in for coverage. Review-only work must not alter product sources.

## Trace Before Comparing

Follow a concrete producer through state/normalization, effects, consumers and
cleanup. Record the subject, asserted fact or requested outcome, authority,
scope/generation, lifetime and user intent. Use a small comparison table only
when there are multiple variants to compare.

Ask whether an apparent inconsistency is:

- one meaning implemented or documented differently;
- different meanings accidentally using one label, flag or representation;
- a missing, conflicting or bypassed shared rule;
- an intentional adaptation supported by capability, authority or user context.

Compare timing as well as steady appearance: initial state, update, replacement,
failure/recovery and retirement. For async work, check A replaced by B before
A's completion or cleanup. For presentation, check actual state against copy,
icon, comic, mascot, motion and announcement, including simultaneous surfaces.
Do not infer progress from decoration, availability from configured capability,
or media readiness from signaling alone.

## Correct The Owning Boundary

When fixes are authorized, choose the smallest coherent correction at the
existing owner and update its reachable consumers. Share implementation where
the semantics and lifetime match; use narrow adapters for real runtime or
presentation differences. A similar name or repeated syntax is not sufficient
reason to merge states or introduce a generic manager.

If the intended semantics are unresolved, put that decision in
[TODO](../../../docs/todo.md) and continue independent checks. Do not turn a
proposal into a mandatory rule merely by adding it to a table.

Verify the changed producer-to-consumer boundary with existing previews, tests
or bounded runtime checks. Check that the correction preserves justified
differences and removes obsolete writers, mappings or timers. Stop broadening
verification after relevant checks pass unless new evidence warrants it.

## Deliver Useful Findings

Group occurrences by their root ownership or contract issue. Give each confirmed
finding its intended rule, reachable trigger, evidence, affected scope, smallest
correction and regression risk. Label unverified suspicions and design choices
separately. Do not claim a repository-wide pass from static searches or one view.

Use the existing owner map as the index of standards. Consolidating files must
preserve ownership, inbound links, tool-discovered paths and contributor entry
points; test those references after moves. Keep architectural rationale, user
guides and temporary audit evidence distinct from normative rules.

Absorb accepted lessons into their existing owner, keep remaining work in TODO,
and leave completed history in Git/PRs. Raw inventories, screenshots and audit
reports remain ignored working artifacts. Do not add a parallel permanent audit
ledger, scoring system, new dependency or extra approval flow.
