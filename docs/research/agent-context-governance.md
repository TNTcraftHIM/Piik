# Agent Context And Documentation Governance

- Reviewed: 2026-08-27
- Scope: repository context, durable memory, documentation types, and decisions
- Status: evidence; repository policy is owned by
  [documentation ownership](../standards/documentation.md)

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

### Instructions And Skills

Reviewed: 2026-10-22.

OpenAI's current guidance favors task-scoped references, short skill descriptions
and explicit completion boundaries. Its documented OSS workflow separates
repository policy from reusable skill methods. The Agent Skills community
guidance likewise recommends coherent purposes, detail proportional to task
fragility, and refinement against real execution. A skill need not carry its
own scripts, reference tree or elaborate procedure to be useful.

Codex loads an instruction chain from global scope through the working directory;
more specific project instructions follow broader ones. Skill descriptions
select workflows whose bodies load on use. Same-named skills are not merged, so
Piik links its repo adaptations explicitly. This loading behavior is distinct
from project authority: a skill cannot grant a release, change an accepted
product contract or weaken a user's task boundary.

The community Ponytail and Stop That Shit approaches support reuse and completion
with less speculative work. Piik keeps those principles but evaluates total
ownership and the complete experience, rather than line count or the first
working implementation. Its Ponytail adaptation removes forced persistence,
fixed response length and per-branch test prescriptions; upstream attribution
remains in the skill's [provenance](../../.agents/skills/ponytail/UPSTREAM.md).
New mechanisms still need relevant end-to-end evidence. Required design thinking
does not imply a separate design document, review agent or approval for each edit.

Sources:

- [OpenAI: Rethinking skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
- [OpenAI: Using skills for OSS maintenance](https://developers.openai.com/blog/skills-agents-sdk)
- [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [skill loading](https://learn.chatgpt.com/docs/build-skills)
- [Agent Skills best practices](https://agentskills.io/skill-creation/best-practices) and [specification](https://agentskills.io/specification)
- [Stop That Shit](https://github.com/lennney/stop-that-shit/blob/0.2.4/skills/stop-that-shit/SKILL.md) and [STSS](https://github.com/lennney/stop-that-shit/blob/0.2.4/skills/stss/SKILL.md): complete the responsibility and omit unnecessary work or self-justifying prose.
- [Avoid Over-Defensive Programming](https://github.com/aravelo7/codex-agent-skills/blob/main/skills/avoid-overdefensive-programming/SKILL.md): fix the producing owner; Piik does not adopt a per-branch reporting procedure.

The earlier community reports about
[small-task expansion](https://www.reddit.com/r/codex/comments/1vf5elq/how_do_you_stop_codexclaude_from_overengineering/)
and [ignored context](https://www.reddit.com/r/codex/comments/1ujnwxb/codex_quality_issues_in_realworld_coding_ignored/)
describe task expansion and repeated work during ordinary development.

### Direct Communication

Reviewed: 2026-10-22.

OpenAI recommends concise, factual delivery and brief, specific instructions.
The community Humanizer skill identifies stacked qualifiers, knowledge-limit
disclaimers, draft narration and replies to objections the reader never raised.
Its adopted issue #198 supplies a useful edit: remove the abandoned objection
and state the actual point.

Piik's [copy owner](../standards/naming.md#voice-and-terminology) applies this to
agent replies and reader documentation: answer first, state usable conditions,
then give the next action. Research keeps measured conditions and results.

Sources:

- [OpenAI Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- [OpenAI reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices)
- [Humanizer skill](https://github.com/blader/humanizer/blob/main/SKILL.md) and its adopted [invisible-context defenses report](https://github.com/blader/humanizer/issues/198)

## Applicability

Piik is small enough that a vector database, memory provider, generated code
map, parallel agent-context format, or separate RFC repository would add more
ownership than it removes. The useful practices are bounded always-on context,
one owner per fact, domain-shaped reference, evidence on demand, short ADRs,
link checks, and Git-backed history. Exact repository policy remains in
[documentation ownership](../standards/documentation.md), not in this research note.
