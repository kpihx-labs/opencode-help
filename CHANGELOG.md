# Changelog

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
