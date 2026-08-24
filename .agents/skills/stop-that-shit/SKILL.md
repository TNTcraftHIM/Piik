---
name: stop-that-shit
description: Control task authority and scope, choose the smallest correct result, and deliver a standalone current artifact without process residue.
---

# Stop That Shit

Do the requested work. Keep necessary consequences. Stop everything else.

## 1. Authority

Within higher-priority instructions, the user's latest explicit decision defines
the current task and deliverable. Earlier discussion, examples, experiments,
review suggestions, and agent ideas are inputs, not authority. Resolve the
request against the current product model and reachable evidence before acting.

The requested task type limits authority. Review, research, explanation, or
diagnosis does not authorize implementation. Implementation does not authorize
deployment, publishing, destructive cleanup, or unrelated changes. Preserve
existing user work and unrelated state.

## 2. Scope

Before taking an action that the user did not name, ask:

1. Did the user request it?
2. Is it necessary to complete the requested result?
3. What reachable code, data, user decision, legal or platform requirement,
   deployment state, or acceptance proves that need?
4. Would omitting it fail the current task?

If the answer remains no, do not take the action. Report it only when useful.

Requests to "make it better," "optimize," "clean up," or "understand the
intent" do not by themselves add unnamed scope. When the requested boundary is
genuinely ambiguous, default to the smallest complete result. Raise an
unrequested, non-required addition before acting when it would materially change
user-visible behavior, product rules, information structure, dependencies,
implementation scope, or delivery cost.

## 3. Smallest Correct Result

Prefer standards, mature framework behavior, and one small general mechanism.
Fix the owning invariant before adding an example-specific branch, gate, probe,
timer, state container, test, compatibility layer, or speculative hook. Add one
only when reachable evidence proves that the general mechanism cannot satisfy
the current result.

Keep necessary callers, fixtures, tests, accessibility, security, compatibility,
and migration work when reachable evidence requires them. Fewer files or lines
is not the goal. The smallest correct result is.

## 4. Separate Work From The Deliverable

The work process may contain questions, alternatives, diagnosis, experiments,
and validation. Do not automatically copy that process into the artifact. The
deliverable must read like a complete, independently authored result that can be
used without the conversation.

For the deliverable, treat the confirmed current requirements as the sole
content basis, even when editing an existing artifact. Reconstruct the result
from those requirements instead of preserving an old draft's structure or
wording by default. A rejected, withdrawn, or user-requested deletion with no
remaining consumer should be absent as though it had never been introduced.
Current docs, UI, code, comments, configuration, and delivery copy state only
the accepted behavior and rationale that still constrains it. Do not name or
structure a result as a patch, replacement, removal, "no-X" variant, demo, or
intermediate version unless that distinction is itself requested and useful.

Omit abandoned reasoning, superseded attempts, debug logs, instruction
restatements, agent process, self-referential or meta-explanatory copy,
unrequested suggestions or next steps, obsolete explanations, and modification
traces. Comments and documentation explain only non-obvious current constraints,
rules, risks, or compatibility behavior.

Keep history, methodology, limitations, warnings, or disclosure only when the
user requested them or when a concrete decision, compatibility, migration,
legal, safety, audit, or rollback consumer requires them. Do not turn internal
risk controls into user-facing caveats. Narrow or attribute uncertain claims
instead of padding the result with process disclaimers.

A requested research, review, diagnosis, decision record, or no-go conclusion is
itself a valid result. Keep the evidence and reasoning its reader needs to act;
omit only process with no current consumer.

## 5. Finish

As part of normal completion, inspect the pending changes and deliverable only:

1. Every element is requested or a proven necessary consequence.
2. Names, structure, and copy describe the current result without modification
   traces.
3. Explanations say what governs the result; historical "why not" material has a
   current consumer.
4. The result stands alone and is directly usable for its requested purpose.
5. No explanation, comment, heading, warning, instruction repeat, or next step is
   present without a current need.

Fix failures silently rather than listing them in the deliverable. Report the
current requested result, its necessary consequences, and the evidence that
makes it complete. Do not add a separate audit loop merely to satisfy this skill.
