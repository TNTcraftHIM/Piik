# Agent Context And Documentation Governance

- Reviewed: 2026-08-27
- Scope: repository context, durable memory, documentation types, and decisions
- Status: evidence; repository policy is owned by
  [maintenance](../standards/documentation.md)

## Findings

### Repository Context

OpenAI's agent-first repository treats `AGENTS.md` as a map into a structured,
versioned knowledge base. Its reported failure mode for one large instruction
file is the same one observed in Piik: scarce context is crowded out, every
rule appears equally important, stale guidance accumulates, and ownership is
hard to verify. The recommended corrective structure is progressive disclosure,
cross-links, and mechanical freshness/structure checks. Codex concatenates the
applicable project instruction chain until `project_doc_max_bytes`, whose
default is 32 KiB.

Hermes distinguishes project conventions (`AGENTS.md`) from user preference,
personality, and learned memory. Its persistent memory is deliberately bounded
and curated; full session history remains searchable on demand rather than being
injected into every prompt. Memory is a frozen session-start snapshot, so it
cannot replace current repository truth. Its context-file limit is configurable
or dynamically derived with a 20,000-character floor, and it recommends staying
below that value and using nested context for genuinely distinct subtrees. Its
bounded-memory guidance starts consolidation at 80% rather than treating the
hard limit as the normal operating target.

Piik therefore warns at 80% of a loader limit, then fails at the loading boundary:
32 KiB for the Codex chain and 20,000 characters for Hermes. The same envelope applies to the
repo Ponytail skill because `AGENTS.md` requires it for coding work. A failure tells the
maintainer to use nested/path-scoped context, on-demand skills or linked docs,
remove duplication and completed history, and delete stale conclusions; raising
the ceiling is not the default remedy.

Sources:

- [OpenAI Harness engineering](https://openai.com/index/harness-engineering/)
- [OpenAI Codex `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Hermes file ownership](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/which-file-does-what.md)
- [Hermes context files](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/context-files.md)
- [Hermes persistent memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)

### Documentation Shape

Diataxis separates tutorial, how-to, reference, and explanation because mixing
reader goals makes each form harder to use. Piik's internal product modules
are compact reference; ADRs are explanation of a decision; deployment is a
how-to/reference boundary; research is evidence and explanation. The framework
does not require creating all four categories when there is no reader need.

An ADR should be a short record of one decision: context, decision, material
consequences, status, and links to supporting evidence. If a decision changes,
the old record is superseded instead of being expanded into a current manual.

Git commits and pull requests own completed history. Current product and
operations documents should not preserve rejected alternatives, release diaries,
or agent process solely for chronology.

Sources:

- [Diataxis primer](https://diataxis.fr/start-here/)
- [Martin Fowler: Architecture Decision Record](https://martinfowler.com/bliki/ArchitectureDecisionRecord.html)
- [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)

## Applicability

Piik is small enough that a vector database, memory provider, generated code
map, parallel agent-context format, or separate RFC repository would add more
ownership than it removes. The useful practices are bounded always-on context,
one owner per fact, domain-shaped reference, evidence on demand, short ADRs,
link checks, and Git-backed history. Exact repository policy remains in
[maintenance](../standards/documentation.md), not in this research note.
