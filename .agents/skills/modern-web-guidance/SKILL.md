---
name: modern-web-guidance
description: >
  Apply current Web platform guidance to Piik browser capability, accessibility,
  responsive layout, overlay, interaction and performance work. Consult matching
  guides when choosing an implementation or investigating browser behavior;
  not for routine copy edits, backend work or unrelated tooling.
license: Apache-2.0
metadata:
  source: GoogleChrome/modern-web-guidance
---

# Modern Web Guidance · Piik

Adapted from [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance).
[Source and adaptation](./UPSTREAM.md) record the reviewed revision and license.

For visual work, use this alongside [Unslop](../unslop/SKILL.md): this skill selects appropriate Web
primitives and checks their browser behavior; Unslop reviews the product's
composition and visual hierarchy. Neither replaces Piik's
[visual language](../../../docs/standards/visual-language.md) or
[engineering boundaries](../../../docs/standards/engineering.md).

## Find The Relevant Guidance

Translate the requested behavior into a concrete platform task, such as
"light dismiss dialog", "container size layout" or "IME-safe Enter submit".
Use the [reviewed guide directory](https://github.com/GoogleChrome/modern-web-guidance/tree/4dd968349e54ca45a05dd5c818fb035c9054b022/skills/modern-web-guidance/guides)
to locate and read the matching guide. Read referenced details only when they
affect this task; do not load the entire collection or add unrelated features.

If the upstream CLI is already available, its focused `search` and `retrieve`
commands are another way to reach the same guides. Installing a tool or scanning
the whole repository is not required for a component change. For a new API or
support claim, also check current official documentation; a pinned guide gives
provenance, not a permanent browser-compatibility guarantee.

Useful starting points in that directory:

- `ui-components/dialog.md`, `ui-behaviors/light-dismiss-a-dialog.md`: modal
  versus non-modal interaction, dismissal and focus.
- `ui-atoms/position-aware-tooltips.md`: viewport-aware supplementary hints.
- `css/size-aware-styling.md`: components adapting to their actual container.
- `forms/ime-safe-enter-submit.md`: composition and submit behavior.
- `user-experience/content-first-noise-reduction.md`: space and attention;
  retain the user's accepted directly accessible controls.

## Apply At The Existing Owner

Inspect the shared Piik component before adding a local implementation. Prefer
native elements for their semantics, focus, keyboard and top-layer behavior.
Keep React-owned state and DOM lifetimes coherent: moving a panel must not
recreate its media, discard a draft or revoke a connection.

Use capability checks and the project's supported-browser policy for required
behavior. Keep an existing fallback when a supported browser still needs it;
remove redundant code only after its replacement has demonstrated that behavior.
Guide examples, fixed percentages, dependency suggestions and blanket mandates
are not Piik product requirements. Do not add a polyfill, hide a frequent action
or change build targets merely to imitate an example.

For accessibility, confirm meaningful names, keyboard operation, focus and
touch use in the affected flow. For layout, check the real shared component in
its narrow and wide containers. For performance, measure the reported problem
with the existing tools before changing loading, scheduling or rendering.
Website loading metrics do not measure media quality or end-to-end latency.

Use the repository's existing preview and relevant checks to verify the outcome,
including dismissal and lifecycle paths affected by the change. Report the
concrete choice and evidence where useful. There is no mandatory extra report
section, full-site audit or scan-to-zero target.
