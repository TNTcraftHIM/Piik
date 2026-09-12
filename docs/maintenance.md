# Documentation Ownership

The repository is the durable source across sessions, devices and agents.
Use [the documentation map](./README.md) to find a topic, then update its owner.
Chat, agent summaries and an old branch do not replace current code, contracts
and evidence. Task authority stays in [AGENTS.md](../AGENTS.md); delivery and
verification procedures stay in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Owners

| Topic | Owner | Keep here |
| --- | --- | --- |
| Universal constraints and navigation | `AGENTS.md` | Short mandatory boundaries and links; no procedure manual |
| Branches, review, validation, PRs, releases and cleanup | `CONTRIBUTING.md` | Executable workflow |
| Module boundaries, interface discipline and ablation | [Engineering](./reference/engineering.md) | Current responsibility map and shared coding rules |
| Names, terminology and voice | [Naming and copy](./reference/naming.md) | Product/tool names, role labels and Chinese/English writing conventions |
| Illustration, palette, motion and accessible layout | [Visual language](./design/visual-language.md) | Shared Browser/App design grammar |
| Status projection | [Media status](./design/media-status.md) | Which facts each display surface may express |
| Release identity and compatibility | [Versioning](./reference/versioning.md) | Version roles, protected interfaces and public-readiness boundary |
| Current product behavior | `docs/product/` | One owner per domain; promises, boundaries and non-obvious invariants |
| Architecture decisions | `docs/adr/` | Decision status, rationale and consequences; explicitly supersede changed clauses |
| Measurements and external evidence | `docs/research/` | Date, sources, observations, inference, limits and license scope |
| Deployment and configuration | `docs/deployment.md`, `docs/operations/`, `docs/reference/configuration.md` | Runnable operator reference; no per-release diary |
| Compact product map | `docs/project-memory.md` | Stable summaries and domain navigation, not implementation inventories |
| Current execution/deployment index | `docs/status.md` | Current boundaries and pointers; exact artifact identity stays in release metadata |
| Remaining work and decisions | `docs/todo.md` | One task ledger, with executable work separated from parked ideas |
| Unresolved physical acceptance | `docs/verification-status.md` | Still-relevant evidence gaps across modules |
| Completed history | Git commits and PRs | Changes and outcomes; do not reproduce them in memory or TODO |

Source schemas and existing conformance fixtures own exact interface fields;
package comments own local lock/resource invariants. The engineering reference
links to them instead of copying every field. README and guides explain how to
use the product; technical details link to the relevant owner. English/Chinese
entry guides are intentional translations and must change together; technical
references keep one version.

## Updating A Rule

1. Trace the current product contract, actual callers and relevant evidence.
   Search hits are leads, not proof of a defect. Separate an implementation
   mismatch from a historical decision or a still-unaccepted proposal.
2. Update the existing owner first. Add a new owner only for a distinct topic
   with real consumers; give it an entry in the documentation map. Delete
   replaced normative text elsewhere and link to the owner.
3. Keep current owners consistent. Update memory/status only when their compact
   snapshot materially changes; put unresolved work in TODO. Checkpoint and
   integration timing follows CONTRIBUTING, not an automatic extra commit for
   every small edit.

When semantics are disputed, record the decision needed and hold only dependent
implementation. At handoff or a material phase change, persist accepted rules,
remaining work and actual blockers before relying on a conversation summary.
Do not store tool transcripts, raw logs, temporary paths or repeated completed
checklists as product truth.
After an audit, put accepted constraints in their existing owners and unresolved
work in TODO, then remove the report and handoff bundle. Do not create dated
audit-summary directories or replacement archives of completed work.

Published copy describes Piik's behavior and design directly. Remove discarded
design labels, private operational details and conversational comparisons to
other products. Retain primary technical evidence and required attribution or
license notices; rewriting prose must not obscure the origin of reused work.

## Consolidation And Ablation

Keep one owner per fact, with short summaries where navigation needs them.
Consolidation is not concatenating documents into one giant manual. Remove
stale procedures and duplicated prescriptions; preserve still-consumed behavior,
failure boundaries, reasoning and reproducible evidence. An ADR can retain a
historical decision when its superseded status is clear.

Document cost is part of [engineering ablation](./reference/engineering.md#ablation-and-review).
Do not delete a product promise solely to shrink a file. Archive completed work
in Git, keep candidate ideas out of active instructions, and never promote an
agent suggestion to accepted policy simply by writing it in a checklist.

The top-level context stays a map. Directory-specific instructions belong near
the code only when that module exists and the rule is needed every time.
The [context-governance research](./research/agent-context-governance.md) owns
the external rationale; the existing hygiene scripts own executable limits.
Their gardening warnings invite review, not arbitrary compression; hard failures
for broken links, required owners and instruction-loading limits remain binding.

## Checks

For documentation work use the existing link, whitespace and repository-hygiene
checks; do not rerun unrelated media benchmarks. The shared
[`required-project-paths.txt`](../scripts/required-project-paths.txt) lists durable
owners for both hygiene entry points. No additional checker is needed for each
new convention.

At a meaningful integration boundary check that current documents agree, links
resolve, and memory/status/TODO still describe what remains. Expensive evidence
retains its measured revision, environment and limits; rerun it when a relevant
contract, dependency, platform, workload or unexplained failure changes.
