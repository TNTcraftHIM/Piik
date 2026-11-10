---
name: unslop
description: >
  Design, review or polish material Piik UI surfaces through product-specific
  visual hierarchy, grouping and real rendered states. Use for visual design,
  redesign and UI polish, not routine backend work or prose-only edits.
license: CC-BY-4.0
metadata:
  author: Damir Sokolovsky
---

# Unslop · Piik

Adapted from Unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)).
[Provenance and changes](./UPSTREAM.md) retain the pinned source and license.

## Start From The Product

Read the affected flow and its existing components, then view the actual screen.
Establish what the user is doing, the main content, supporting actions and state
owners before adjusting details. Use Piik's accepted direction and the user's
latest design decisions; describe a new direction only when the task needs one.
Routine choices within an authorized design task do not require another approval.

[Visual language](../../../docs/standards/visual-language.md) owns presentation;
[engineering](../../../docs/standards/engineering.md) owns state and lifecycle.
This skill supplies a visual review method, not another design system.

## Compose The Whole Screen

Give the current task a clear centre of attention. Judge the main picture,
conversation, people, navigation and controls together, including the first
screen and secondary surfaces. Removing decoration alone does not establish
hierarchy or make the result recognizably Piik.

Group by meaning, scope and frequency. A visual boundary should explain which
object an action changes; proximity must not imply shared authority where none
exists. Preserve independent sharing, watching, voice and conversation owners.

Use the existing spacing rhythm as a coherent grid across adjacent panes:
align corresponding edges, headers, labels and control groups. Check shared
baselines in the rendered composition. Visual alignment does not require merging
independent component state, scrolling, sessions or resource lifetimes.

Reuse the actual shared controls, typography, tokens and semantic colours.
Correct an inconsistent shared owner instead of adding a scene-specific variant.
Keep navigation and supporting chrome quiet enough for meaningful content to
lead. Preserve Piik's people, illustrations, reactions and purposeful motion.

## Check The Real Result

Render representative empty, active and crowded states using existing previews
and plausible, internally consistent sample data. Check long names, translations,
themes and the responsive widths/heights affected by the change. Reflow groups
and assign space by task priority rather than shrinking all content equally.

Exercise the changed primary action, return/cancel path and keyboard/touch
access where relevant. Confirm that useful content, focus and independent
activities survive surface changes. Preview props are evidence of presentation;
platform permissions and live transport still need their actual owners' checks.

Fix concrete hierarchy, grouping, alignment and interaction problems together at
the smallest coherent scope. Compare the rendered result with the intended flow,
then stop when it works. Report meaningful changes, evidence and remaining
limits; keep temporary screenshots in ignored build output.
