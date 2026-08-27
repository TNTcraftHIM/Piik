# Agent Context And Documentation Governance

- Reviewed: 2026-08-27
- Scope: repository context, durable memory, documentation types, and decisions
- Status: evidence; repository policy is owned by
  [maintenance](../maintenance.md)

## Findings

### Repository Context

OpenAI's agent-first repository treats `AGENTS.md` as a map into a structured,
versioned knowledge base. Its reported failure mode for one large instruction
file is the same one observed in Screener: scarce context is crowded out, every
rule appears equally important, stale guidance accumulates, and ownership is
hard to verify. The recommended corrective structure is progressive disclosure,
cross-links, and mechanical freshness/structure checks.

Anthropic likewise recommends concise, specific project instructions and moves
multi-step procedures or path-specific rules to on-demand skills or scoped rule
files. A size ceiling is not a target.

Hermes distinguishes project conventions (`AGENTS.md`) from user preference,
personality, and learned memory. Its persistent memory is deliberately bounded
and curated; full session history remains searchable on demand rather than being
injected into every prompt. Memory is a frozen session-start snapshot, so it
cannot replace current repository truth. Nested context is useful only when a
subtree has genuinely distinct rules.

Sources:

- [OpenAI Harness engineering](https://openai.com/index/harness-engineering/)
- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Hermes file ownership](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/which-file-does-what.md)
- [Hermes persistent memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)

### Documentation Shape

Diataxis separates tutorial, how-to, reference, and explanation because mixing
reader goals makes each form harder to use. Screener's internal product modules
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

Screener is small enough that a vector database, memory provider, generated code
map, parallel agent-context format, or separate RFC repository would add more
ownership than it removes. The useful practices are bounded always-on context,
one owner per fact, domain-shaped reference, evidence on demand, short ADRs,
link checks, and Git-backed history. Exact repository policy remains in
[maintenance](../maintenance.md), not in this research note.
