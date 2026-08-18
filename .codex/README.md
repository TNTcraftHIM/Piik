# Project Codex Configuration

This directory contains portable, project-scoped Codex configuration. It is intentionally tracked with the repository so contributors receive the same project behavior across machines.

Codex loads `.codex/config.toml` only after the repository is trusted. The root `AGENTS.md` contains the durable project instructions. Project research and decisions live under `docs/`.

Do not place provider credentials, tokens, private endpoints, personal preferences, or machine-specific permission settings here. Those belong in the user's local Codex configuration or environment.

Official references:

- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Project-scoped Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic)
