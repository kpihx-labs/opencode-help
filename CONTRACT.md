# Contract

## Scope

`opencode-help` creates ordinary **root** OpenCode sessions and records an
owner→peer capability in a local SQLite registry. It never uses OpenCode's
`task` tool or creates child sessions. The plugin is passive: no peer is
opened, prompted, resumed, or closed unless its owning parent calls a tool.

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| `help_open` | `prompt`, required `agent` | Admits capacity before creating and starting an owned root peer. |
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
- `help_open.agent` must appear in OpenCode's current agent list with mode `subagent` or `all`; primary-only and unknown agents are rejected.
- Rejected `help_open` concurrency admissions fail before OpenCode session creation,
  so no unprompted or archived session is left behind.
- The registry is WAL SQLite, and queue claims are transactions. Pending
  messages survive process restarts; stale claims recover after 60 seconds.
- Queue servicing is internally timer-driven, bounded by `queueIntervalMs`; it
  is not an assumption that callers must poll.

## Model handling

`help_open` requires an explicit OpenCode-delegable agent. Its model is selected only by the plugin configuration; the caller cannot override it. The configured `provider/model-id` is split once into
`{ providerID, modelID }` and sent as `body.model` on OpenCode SDK
`session.promptAsync`. The agent name and model are stored with the peer and
reused for every queued or steered prompt. Invalid configured values fail before prompting.

## Non-goals

No auto-spawn, auto-escalation, global peer access, session deletion, purge
tool, worktree creation, or code/result merging is provided in v1.
