import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

type Bindings = Extract<SQLQueryBindings, Record<string, unknown>>

export type ModelSelection = { providerID: string; modelID: string }
export type Peer = {
  ownerSessionID: string
  sessionID: string
  directory: string
  agent: string
  model?: ModelSelection
  archived: boolean
  createdAt: number
  archivedAt?: number
}
export type QueuedMessage = {
  id: string
  ownerSessionID: string
  sessionID: string
  text: string
  agent: string
  model?: ModelSelection
  attempts: number
}

export class HelpRegistry {
  #db: Database

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.#db = new Database(path, { create: true })
    this.#db.run("PRAGMA journal_mode = WAL")
    this.#db.run("PRAGMA busy_timeout = 5000")
    this.#db.run(`CREATE TABLE IF NOT EXISTS peer (
      owner_session_id TEXT NOT NULL, session_id TEXT PRIMARY KEY, directory TEXT NOT NULL,
      agent TEXT NOT NULL, provider_id TEXT, model_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
      active_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, archived_at INTEGER
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL,
      agent TEXT NOT NULL, provider_id TEXT, model_id TEXT, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, claimed_at INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS admission (
      id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`)
    this.#db.run("CREATE INDEX IF NOT EXISTS peer_owner ON peer(owner_session_id, archived, created_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS queue_ready ON queue(state, next_attempt_at, created_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS admission_owner ON admission(owner_session_id, expires_at)")
  }

  add(peer: Omit<Peer, "archived" | "createdAt"> & { createdAt?: number }) {
    const createdAt = peer.createdAt ?? Date.now()
    this.#db.query(`INSERT INTO peer (owner_session_id, session_id, directory, agent, provider_id, model_id, created_at)
      VALUES ($owner, $session, $directory, $agent, $provider, $model, $created)`).run({
      $owner: peer.ownerSessionID, $session: peer.sessionID, $directory: peer.directory, $agent: peer.agent,
      $provider: peer.model?.providerID ?? null, $model: peer.model?.modelID ?? null, $created: createdAt,
    })
  }

  owned(ownerSessionID: string, sessionID: string, includeArchived = false): Peer | undefined {
    const row = this.#db.query<Record<string, unknown>, Bindings>(
      `SELECT * FROM peer WHERE owner_session_id = $owner AND session_id = $session ${includeArchived ? "" : "AND archived = 0"}`,
    ).get({ $owner: ownerSessionID, $session: sessionID })
    return row === null ? undefined : toPeer(row)
  }

  isManaged(sessionID: string) {
    return this.#db.query("SELECT 1 FROM peer WHERE session_id = $session").get({ $session: sessionID }) !== null
  }

  list(ownerSessionID: string, includeArchived = false): Peer[] {
    return this.#db.query<Record<string, unknown>, Bindings>(
      `SELECT * FROM peer WHERE owner_session_id = $owner ${includeArchived ? "" : "AND archived = 0"} ORDER BY created_at`,
    ).all({ $owner: ownerSessionID }).map(toPeer)
  }

  archive(ownerSessionID: string, sessionID: string) {
    return this.#db.query("UPDATE peer SET archived = 1, archived_at = $now, active_until = 0 WHERE owner_session_id = $owner AND session_id = $session AND archived = 0")
      .run({ $owner: ownerSessionID, $session: sessionID, $now: Date.now() }).changes === 1
  }

  resume(ownerSessionID: string, sessionID: string) {
    return this.#db.query("UPDATE peer SET archived = 0, archived_at = NULL WHERE owner_session_id = $owner AND session_id = $session AND archived = 1")
      .run({ $owner: ownerSessionID, $session: sessionID }).changes === 1
  }

  active(directory: string, now = Date.now()) {
    return this.#db.query<{ session_id: string }, Bindings>("SELECT session_id FROM peer WHERE directory = $directory AND archived = 0 AND active_until > $now")
      .all({ $directory: directory, $now: now }).map((row) => row.session_id)
  }

  admit(ownerSessionID: string, max: number, expiresAt: number) {
    return this.#db.transaction(() => {
      const now = Date.now()
      this.#db.query("DELETE FROM admission WHERE expires_at <= $now").run({ $now: now })
      const active = this.#db.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM peer WHERE owner_session_id = $owner AND archived = 0 AND active_until > $now")
        .get({ $owner: ownerSessionID, $now: now })?.count ?? 0
      const pending = this.#db.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM admission WHERE owner_session_id = $owner AND expires_at > $now")
        .get({ $owner: ownerSessionID, $now: now })?.count ?? 0
      if (active + pending >= max) return undefined
      const id = crypto.randomUUID()
      this.#db.query("INSERT INTO admission (id, owner_session_id, expires_at) VALUES ($id, $owner, $expires)").run({ $id: id, $owner: ownerSessionID, $expires: expiresAt })
      return id
    })()
  }

  releaseAdmission(id: string) { this.#db.query("DELETE FROM admission WHERE id = $id").run({ $id: id }) }

  reserve(ownerSessionID: string, sessionID: string, max: number, until: number) {
    return this.#db.transaction(() => {
      const peer = this.owned(ownerSessionID, sessionID)
      if (!peer) return false
      const now = Date.now()
      const current = this.#db.query<{ active_until: number }, Bindings>("SELECT active_until FROM peer WHERE session_id = $session").get({ $session: sessionID })
      if (!current || current.active_until <= now) {
        const count = this.#db.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM peer WHERE owner_session_id = $owner AND session_id != $session AND archived = 0 AND active_until > $now")
          .get({ $owner: ownerSessionID, $session: sessionID, $now: now })?.count ?? 0
        if (count >= max) return false
      }
      this.#db.query("UPDATE peer SET active_until = $until WHERE session_id = $session").run({ $session: sessionID, $until: until })
      return true
    })()
  }

  markActive(sessionIDs: Iterable<string>, directory: string, until: number) {
    const update = this.#db.query("UPDATE peer SET active_until = $until WHERE session_id = $session AND directory = $directory AND archived = 0")
    this.#db.transaction(() => { for (const sessionID of Array.from(sessionIDs)) update.run({ $session: sessionID, $directory: directory, $until: until }) })()
  }

  enqueue(message: Omit<QueuedMessage, "attempts">) {
    const now = Date.now()
    this.#db.query(`INSERT INTO queue (id, owner_session_id, session_id, text, agent, provider_id, model_id, next_attempt_at, created_at)
      VALUES ($id, $owner, $session, $text, $agent, $provider, $model, $now, $now)`).run({
      $id: message.id, $owner: message.ownerSessionID, $session: message.sessionID, $text: message.text, $agent: message.agent,
      $provider: message.model?.providerID ?? null, $model: message.model?.modelID ?? null, $now: now,
    })
  }

  pending(directory: string, now = Date.now()): QueuedMessage[] {
    this.#db.query("UPDATE queue SET state = CASE WHEN attempts >= 7 THEN 'failed' ELSE 'pending' END, attempts = attempts + 1, claimed_at = NULL WHERE state = 'sending' AND claimed_at < $stale")
      .run({ $stale: now - 60_000 })
    return this.#db.query<Record<string, unknown>, Bindings>(`SELECT q.* FROM queue q JOIN peer p ON p.session_id = q.session_id
      WHERE q.state = 'pending' AND q.next_attempt_at <= $now AND p.directory = $directory AND p.archived = 0 ORDER BY q.created_at`)
      .all({ $directory: directory, $now: now }).map(toQueued)
  }

  claim(id: string, max: number, until: number) {
    return this.#db.transaction(() => {
      const row = this.#db.query<{ owner_session_id: string; session_id: string; active_until: number }, Bindings>("SELECT q.owner_session_id, q.session_id, p.active_until FROM queue q JOIN peer p ON p.session_id = q.session_id WHERE q.id = $id AND q.state = 'pending' AND p.archived = 0").get({ $id: id })
      if (!row || Number(row.active_until) > Date.now()) return false
      const count = this.#db.query<{ count: number }, Bindings>("SELECT COUNT(*) AS count FROM peer WHERE owner_session_id = $owner AND session_id != $session AND archived = 0 AND active_until > $now")
        .get({ $owner: row.owner_session_id, $session: row.session_id, $now: Date.now() })?.count ?? 0
      if (count >= max) return false
      if (this.#db.query("UPDATE queue SET state = 'sending', claimed_at = $now WHERE id = $id AND state = 'pending'").run({ $id: id, $now: Date.now() }).changes !== 1) return false
      this.#db.query("UPDATE peer SET active_until = $until WHERE session_id = $session").run({ $session: row.session_id, $until: until })
      return true
    })()
  }

  sent(id: string) { this.#db.query("UPDATE queue SET state = 'sent', sent_at = $now, claimed_at = NULL, last_error = NULL WHERE id = $id AND state = 'sending'").run({ $id: id, $now: Date.now() }) }
  retry(id: string, attempts: number, error: string) {
    const failed = attempts >= 8
    this.#db.query("UPDATE queue SET state = $state, attempts = $attempts, next_attempt_at = $next, claimed_at = NULL, last_error = $error WHERE id = $id AND state = 'sending'")
      .run({ $id: id, $state: failed ? "failed" : "pending", $attempts: attempts, $next: Date.now() + Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)), $error: error })
  }
  queueState(sessionID: string): "queued" | "queue_failed" | undefined {
    const row = this.#db.query<{ state: string }, Bindings>("SELECT state FROM queue WHERE session_id = $session AND state IN ('pending', 'sending', 'failed') ORDER BY CASE WHEN state = 'failed' THEN 1 ELSE 0 END, created_at LIMIT 1").get({ $session: sessionID })
    return row ? (row.state === "failed" ? "queue_failed" : "queued") : undefined
  }
  close() { this.#db.close() }
}

function toPeer(row: Record<string, unknown>): Peer {
  const model = typeof row.provider_id === "string" && typeof row.model_id === "string" ? { providerID: row.provider_id, modelID: row.model_id } : undefined
  return { ownerSessionID: String(row.owner_session_id), sessionID: String(row.session_id), directory: String(row.directory), agent: String(row.agent), ...(model ? { model } : {}), archived: Number(row.archived) === 1, createdAt: Number(row.created_at), ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}) }
}
function toQueued(row: Record<string, unknown>): QueuedMessage {
  const model = typeof row.provider_id === "string" && typeof row.model_id === "string" ? { providerID: row.provider_id, modelID: row.model_id } : undefined
  return { id: String(row.id), ownerSessionID: String(row.owner_session_id), sessionID: String(row.session_id), text: String(row.text), agent: String(row.agent), ...(model ? { model } : {}), attempts: Number(row.attempts) }
}
