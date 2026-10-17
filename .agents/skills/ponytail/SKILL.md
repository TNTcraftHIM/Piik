---
name: ponytail
description: >
  Choose the smallest coherent implementation for Piik coding, code review,
  refactoring and implementation design, including dependency choices.
  Also use when Ponytail or YAGNI is requested; not for ordinary prose or status.
license: MIT
---

# Ponytail · Piik

Reduce what Piik must own while delivering the complete requested experience.
This is an implementation method under [AGENTS.md](../../../AGENTS.md), not
permission to reduce scope or defer design. The repo adaptation and license are
documented in [UPSTREAM.md](./UPSTREAM.md).

## Understand The Responsibility

Read the affected owner and actual flow before choosing a solution. Establish
the user outcome, state/resource lifetime and consumers that must keep working.
For a bug, trace where the incorrect fact or action first arises and check
sibling callers of that owner. Correct that boundary instead of adding a guard
to each symptom. A shared guard is useful only if it restores the real contract.

For UI, inspect the existing interaction and visual primitives before adding a
control, panel, status or animation. A reused component must still have the
right meaning, placement and lifecycle; reuse alone does not establish design
quality. Different responsibilities need not look or behave identically.

## Choose The Smallest Coherent Design

Use this order to find a sufficient solution, not as a mandatory research tour:

1. Remove speculative additions that the requested outcome does not need.
2. Reuse the existing owner, component or helper when its semantics and lifetime fit.
3. Prefer standard-library, native-platform or already-installed capabilities.
4. Use a mature dependency when it reduces total ownership more than custom code.
5. Implement the remaining behavior in a cohesive module with a narrow interface.

Compare user effort, state, dependencies and maintenance, not just lines or file
count. A larger correction is justified when it removes competing writers or
finishes the affected flow. Keep readable code and clear boundaries rather than
compressing logic into a one-liner or one oversized file.

Add an abstraction, setting or extension point only for a current responsibility,
real consumer or accepted contract. Do not build scaffolding for hypothetical
features. Preserve necessary platform adapters; a single implementation alone
does not prove an interface is wasteful. Inspect existing protections before
removing them, and preserve authorization, data integrity, accessibility and
published compatibility.

Comment non-obvious constraints and reasons at their owner. Avoid slogans,
restated code or speculative upgrade plans in comments. Remove replaced private
paths within scope; keep useful provenance and required license notices.

## Verify And Finish

Verify the requested behavior at the affected boundary using the project's
existing checks. New mechanisms need evidence for their actual success,
failure and lifecycle behavior; a test for each branch or helper is not the
goal. Use [Stop That Shit](../stop-that-shit/SKILL.md) to keep verification
proportionate; required checks and delivery remain in
[CONTRIBUTING.md](../../../CONTRIBUTING.md).

Check the result against the intended experience and remove unnecessary
additions. Report the outcome, meaningful evidence and material limits at the
detail the user needs. Do not ship an easier subset as completion or impose a
fixed response length.

## Optional Intensity

Default **full** applies the method above. If requested, **lite** focuses on the
scoped implementation and obvious reuse; **ultra** more aggressively removes
unnecessary ownership within that scope. These levels change simplification
effort, never the requested result, design quality, authority or verification.
