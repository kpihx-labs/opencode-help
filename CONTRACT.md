# Contract

## Scope

`opencode-help` creates ordinary **root** OpenCode sessions and records an
owner→peer capability in a local SQLite registry. It never uses OpenCode's
`task` tool or creates child sessions. The plugin is passive: no peer is
opened, prompted, resumed, or closed unless its owning parent calls a tool.

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| `help_open` | `prompt`, required `agent`, optional permitted `model` | Admits capacity before creating and starting an owned root peer. |
| `help_list` | optional `include_archived` | Lists only caller-owned peers. |
| `help_read` | `peer_id`, optional `limit` | Returns an active owned peer's durable session/messages. |
| `help_message` | `peer_id`, `message`, `delivery: steer\|queue` | Steers now or atomically queues later delivery. |
| `help_wait` | `peer_id`, optional bounded `timeout_seconds` | Returns `idle`, `queue_failed`, or `timed_out`. |
| `help_close` | `peer_id` | Archives/detaches the registry record; never deletes session data. |
| `help_resume` | `peer_id` | Reattaches the caller's archived peer. |

## Authorization and state

- An active peer may only be read, messaged, waited on, or archived by its
  recorded owner session.
- Archived peers are invisible to active operations and queue dispatch; only
  their owner can resume them.
- Managed peer sessions cannot call `help_open`, preventing recursion.
- `help_open.agent` is passed to OpenCode server-side `promptAsync`, which validates it; invalid agent names surface the server error verbatim.
- Rejected `help_open` concurrency admissions fail before OpenCode session creation,
  so no unprompted or archived session is left behind.
- The registry is WAL SQLite, and queue claims are transactions. Pending
  messages survive process restarts; stale claims recover after 60 seconds.
- Queue servicing is internally timer-driven, bounded by `queueIntervalMs`; it
  is not an assumption that callers must poll.

## Model handling

`help_open` requires an explicit agent name. `models` is a required, non-empty,
ordered configuration allowlist of `provider/model-id` values. A caller that
omits `model` receives the first entry; a caller that supplies one may select
only an entry from this list. The selected model is split once into
`{ providerID, modelID }`, sent as `body.model` on OpenCode SDK
`session.promptAsync`, and reused for every queued or steered prompt.

The `help_open` and `help_list` tool descriptions expose this live ordered
pool, including the default. `help_list` returns `defaultModel` and
`permittedModels` alongside caller-owned peers. The JSONC configuration remains
the only source of these values.

There is no automatic fallback. An opening failure archives the new peer and
reports all permitted alternatives so its parent can explicitly call
`help_open` again. A steer failure leaves its peer active and instructs the
parent to `help_close` then explicitly reopen. A terminal durable-queue failure
is returned by `help_wait` with its final OpenCode error and permitted models.

## Non-goals

No auto-spawn, auto-escalation, global peer access, session deletion, purge
tool, worktree creation, or code/result merging is provided in v1.
