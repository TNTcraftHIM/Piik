---
name: rfc2119
description: >
  Write or review requirement levels in specifications, API contracts, ADRs and
  project rules using RFC 2119 and RFC 8174. Use when obligations, recommendations
  or optional behavior need precise wording; not for ordinary guides or UI copy.
---

# Requirement Levels

Use BCP 14 to make an accepted requirement's strength clear. First identify its
authority, scope and intended behavior. Editing the wording preserves those
decisions; proposals remain proposals.

## Choose The Level

| Keywords | Meaning |
| --- | --- |
| MUST / REQUIRED / SHALL | Necessary for conformance within the stated scope. |
| MUST NOT / SHALL NOT | Prohibited within that scope. |
| SHOULD / RECOMMENDED | The recommended course; a valid exception requires understanding and weighing its consequences. |
| SHOULD NOT / NOT RECOMMENDED | Generally discouraged; a justified exception may be appropriate after weighing its consequences. |
| MAY / OPTIONAL | Either implementation choice is permitted. Protocol peers with and without the option still interoperate on the common behavior. |

Use these keywords sparingly for interoperability and harm-prevention boundaries.
State an outcome rather than prescribing an implementation when the contract
does not require that implementation. A capability report describes support;
permission to perform an action belongs to its own authority.

## Write And Review

- Name the responsible actor, applicable condition and observable obligation.
  Keep one requirement in each clause and retain its existing document owner.
- When adopting BCP 14, identify RFC 2119 and RFC 8174 near the document's start
  and use uppercase for their defined keyword meanings. For example:
  “Uppercase requirement keywords use BCP 14 (RFC 2119 and RFC 8174).”
- Ordinary prose can also be normative. Lowercase words retain their ordinary
  meaning; capitalization neither creates authority nor weakens an existing rule.
- Check that each level matches the accepted intent, that optional features
  preserve common behavior, and that examples do not silently add requirements.
  Resolve a genuinely undecided requirement with its owner rather than assigning
  a stronger keyword.

## Sources

- [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119), March 1997:
  requirement levels and restrained use.
- [RFC 8174](https://datatracker.ietf.org/doc/html/rfc8174), May 2017:
  uppercase keywords and normative ordinary prose.
