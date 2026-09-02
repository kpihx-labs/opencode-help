# opencode-help

Durable, explicitly controlled peer help sessions for OpenCode. A parent opens
ordinary root sessions, retains exclusive ownership across restarts, directs
them with immediate `steer` or durable `queue` messages, then archives and
later resumes them—without deleting OpenCode history.

Derived from the MIT-licensed [opzero1/op-thread](https://github.com/opzero1/op-thread).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Safety guarantees

- **No task children:** peers are root OpenCode sessions (`parentID` is absent).
- **Owner capability:** only the recorded parent session can operate on a peer.
- **No recursion:** a managed peer cannot open another help peer.
- **Passive orchestration:** nothing auto-spawns, auto-escalates, or resumes.
- **Safe concurrency:** `maxConcurrent` defaults to 8 (validated range 1–32).
- **Durable queue:** SQLite WAL, transactional claims, retries, and restart recovery.
- **Non-destructive closure:** `help_close` only archives/detaches. There is no
  purge or session-delete tool.
- **Bounded wait:** `help_wait` returns at its configured timeout (max 600s).

## Tools

| Tool | Purpose |
| --- | --- |
| `help_open` | Start an owned root peer with a required OpenCode-delegable subagent. |
| `help_list` | Inspect owned active peers; optionally include archived ones. |
| `help_read` | Read a peer's OpenCode session/messages. |
| `help_message` | Explicitly `steer` immediately or atomically `queue`. |
| `help_wait` | Wait a bounded duration for idle/queue failure. |
| `help_close` | Archive/detach without deleting history. |
| `help_resume` | Reattach the same archived peer session. |

## Model selection: verified direct SDK support

OpenCode SDK **v1.18.26** declares `SessionPromptAsyncData.body.model` as:

```ts
{ providerID: string; modelID: string }
```

`help_open` requires an explicit agent. Before creating a peer, it asks
OpenCode for the session's live agents and accepts only names declared with
mode `subagent` or `all`—the same delegation surface exposed to the caller by
OpenCode. It does not offer a separate catalog.

The model is configuration-only: callers cannot pass one. The configured model
is persisted and reused on `help_message`; an OpenCode rejection is surfaced
verbatim.

## Install

Install from npm when published, or add the future plugin line to OpenCode
configuration (do not add it twice):

```jsonc
{ "plugin": ["opencode-help"] }
```

For a local checkout, use its built module or source entry only after `bun install`.
OpenCode loads plugins at startup; restart OpenCode after configuration changes.

## Configuration

```jsonc
{
  "plugin": [["opencode-help", {
    "maxConcurrent": 8,
    "queueIntervalMs": 250,
    "idleSettleMs": 500,
    "defaultModel": "opencode-go/mimo-v2.5"
  }]]
}
```

The registry defaults to `$XDG_DATA_HOME/opencode-help/registry.sqlite` (or
`$HOME/.local/share/opencode-help/registry.sqlite`). Set `databasePath` only
when deliberately isolating a test or deployment.

## Development

```sh
bun install
make check
```

`make push` pushes the current branch to SSH remotes named `github` and
`gitlab`; no `origin` remote is used.
