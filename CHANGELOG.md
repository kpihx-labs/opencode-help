# Changelog

## 0.3.1 — 2026-09-02

- Removed broken `delegableAgents()` call that used a non-existent SDK API (`client.agent.list`). OpenCode server validates the agent name at `promptAsync` time; the plugin no longer duplicates this.

## 0.3.0 — 2026-09-02

- Removed `help_catalog`, caller-selected models, and the guessed default agent.
- `help_open` now requires an explicit live OpenCode-delegable subagent and rejects primary-only or unknown agents.
- Model selection is configuration-only; the KπX integration fixes it to `opencode-go/mimo-v2.5`.

## 0.2.0 — 2026-09-02

- Added explicit `general` / `opencode-go/mimo-v2.5` defaults, overridable per peer.
- Added read-only `help_catalog` discovery of agents, configured models, effective defaults, and unavailable-provider reasons.

## 0.1.2 — 2026-09-02

- Preserve structured OpenCode SDK errors so invalid agent/model diagnostics remain actionable.

## 0.1.1 — 2026-09-02

- Preserved the upstream op-thread MIT notice verbatim.
- Reject saturated `help_open` admissions before creating an OpenCode session.

## 0.1.0 — 2026-09-02

- Initial public release: durable owner-scoped OpenCode help peers.
- Added open, list, read, message, wait, close, and resume lifecycle tools.
- Added direct per-prompt model selection through OpenCode SDK `promptAsync`.
