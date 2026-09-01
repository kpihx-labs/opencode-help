import type { PluginInput } from "@opencode-ai/plugin"
import type { ModelSelection } from "./registry.js"

type Client = PluginInput["client"]
export type Session = { id: string; parentID?: string; title: string; directory: string; time: { created: number; updated: number } }

export class OpenCodeApi {
  constructor(private readonly client: Client, private readonly directory: string) {}
  async create(title: string, signal?: AbortSignal): Promise<Session> {
    return asSession(unwrap(await this.client.session.create({ body: { title }, query: { directory: this.directory }, signal }), "create session"))
  }
  async get(sessionID: string, signal?: AbortSignal): Promise<Session> {
    return asSession(unwrap(await this.client.session.get({ path: { id: sessionID }, query: { directory: this.directory }, signal }), "get session"))
  }
  async messages(sessionID: string, limit: number, signal?: AbortSignal) {
    return unwrap(await this.client.session.messages({ path: { id: sessionID }, query: { directory: this.directory, limit }, signal }), "read session messages")
  }
  async active(signal?: AbortSignal) {
    const statuses = unwrap(await this.client.session.status({ query: { directory: this.directory }, signal }), "read session status")
    if (!isRecord(statuses)) throw new Error("OpenCode SDK returned invalid session statuses")
    return new Set(Object.entries(statuses).filter(([, status]) => isRecord(status) && status.type !== "idle").map(([id]) => id))
  }
  async prompt(input: { sessionID: string; text: string; agent: string; model?: ModelSelection; messageID: string }, signal?: AbortSignal) {
    const existing = await this.client.session.message({ path: { id: input.sessionID, messageID: input.messageID }, query: { directory: this.directory }, signal })
    if (existing.data !== undefined) return
    unwrap(await this.client.session.promptAsync({ path: { id: input.sessionID }, query: { directory: this.directory }, body: { messageID: input.messageID, agent: input.agent, model: input.model, parts: [{ type: "text", text: input.text }] }, signal }), "send prompt", true)
  }
}

function unwrap(result: unknown, operation: string, allowEmpty = false): unknown {
  if (!isRecord(result)) throw new Error(`OpenCode SDK returned invalid ${operation} result`)
  if (result.error !== undefined) throw new Error(`${operation} failed: ${String(result.error)}`)
  if (result.data !== undefined || allowEmpty) return result.data
  throw new Error(`${operation} returned no data`)
}
function asSession(value: unknown): Session {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.directory !== "string" || !isRecord(value.time) || typeof value.time.created !== "number" || typeof value.time.updated !== "number") throw new Error("OpenCode SDK returned invalid session")
  return { id: value.id, ...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}), title: value.title, directory: value.directory, time: { created: value.time.created, updated: value.time.updated } }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
