import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { OpenCodeApi } from "./api.js"
import { HelpRegistry, type ModelSelection } from "./registry.js"

type Options = { databasePath?: string; maxConcurrent?: number; queueIntervalMs?: number; idleSettleMs?: number; defaultModel?: string }
type Settings = { databasePath: string; maxConcurrent: number; queueIntervalMs: number; idleSettleMs: number; defaultModel: ModelSelection }

export function opencodeHelp(overrides: Options = {}): Plugin {
  return async (input, pluginOptions) => {
    const settings = resolve(overrides, pluginOptions ?? {})
    const registry = new HelpRegistry(settings.databasePath)
    const api = new OpenCodeApi(input.client, input.directory)
    const shutdown = new AbortController()
    const lease = Math.max(500, settings.queueIntervalMs * 4)
    let pump: Promise<void> | undefined
    const active = async (signal?: AbortSignal) => {
      const fromOpenCode = await api.active(signal)
      registry.markActive(fromOpenCode, input.directory, Date.now() + lease)
      return new Set([...fromOpenCode, ...registry.active(input.directory)])
    }
    const owned = (owner: string, peer: string, archived = false) => {
      const value = registry.owned(owner, peer, archived)
      if (!value) throw new Error(`Peer ${peer} is not owned by this session or is archived`)
      return value
    }
    const runPump = async () => {
      try {
        const running = await active(shutdown.signal)
        for (const message of registry.pending(input.directory)) {
          if (running.has(message.sessionID) || !registry.claim(message.id, settings.maxConcurrent, Date.now() + lease)) continue
          try { await api.prompt({ ...message, messageID: message.id }, shutdown.signal); registry.sent(message.id); registry.markActive([message.sessionID], input.directory, Date.now() + lease); running.add(message.sessionID) }
          catch (error) { registry.retry(message.id, message.attempts + 1, errorMessage(error)) }
        }
      } catch { /* Durable queue is retried by the internal worker. */ }
    }
    const trigger = () => {
      if (pump || shutdown.signal.aborted) return
      const current = runPump().finally(() => { if (pump === current) pump = undefined })
      pump = current
    }
    const timer = setInterval(trigger, settings.queueIntervalMs)
    trigger()
    return { tool: {
      help_open: tool({ description: "Create and start a durable root peer through an explicit OpenCode-delegable subagent. The model is controlled only by plugin configuration. Only a non-peer parent may open help peers.", args: {
        prompt: tool.schema.string().min(1), agent: tool.schema.string().min(1),
      }, async execute(args, context) {
        if (registry.isManaged(context.sessionID)) throw new Error("Managed help peers cannot open peers; only their owning parent may do so")
          const model = settings.defaultModel
          const agent = args.agent
        const admission = registry.admit(context.sessionID, settings.maxConcurrent, Date.now() + Math.max(60_000, lease))
        if (!admission) throw new Error(`Concurrent peer limit reached (${settings.maxConcurrent})`)
        try {
          const peer = await api.create(`Help: ${args.prompt.slice(0, 80)}`, context.abort)
          if (peer.parentID) throw new Error("OpenCode returned a child session; refusing non-peer session")
          registry.add({ ownerSessionID: context.sessionID, sessionID: peer.id, directory: context.directory, agent, model })
          if (!registry.reserve(context.sessionID, peer.id, settings.maxConcurrent, Date.now() + lease)) { registry.archive(context.sessionID, peer.id); throw new Error(`Concurrent peer limit reached (${settings.maxConcurrent})`) }
          const id = messageID()
          try { await api.prompt({ sessionID: peer.id, text: args.prompt, agent, model, messageID: id }, context.abort) }
          catch (error) { registry.archive(context.sessionID, peer.id); throw error }
          registry.markActive([peer.id], input.directory, Date.now() + lease)
          return json({ peerID: peer.id, state: "started", agent, model: model ?? "agent/default", messageID: id })
        } finally { registry.releaseAdmission(admission) }
      }}),
      help_list: tool({ description: "List help peers owned by this parent; archived peers are included only when requested.", args: { include_archived: tool.schema.boolean().optional() }, async execute(args, context) {
        const running = await active(context.abort)
        return json({ peers: registry.list(context.sessionID, args.include_archived ?? false).map((peer) => ({ ...peer, state: peer.archived ? "archived" : running.has(peer.sessionID) ? "running" : registry.queueState(peer.sessionID) ?? "idle" })) })
      }}),
      help_read: tool({ description: "Read an owned active help peer's session and recent messages.", args: { peer_id: tool.schema.string().min(1), limit: tool.schema.number().int().min(1).max(50).optional() }, async execute(args, context) {
        owned(context.sessionID, args.peer_id); const [session, messages, running] = await Promise.all([api.get(args.peer_id, context.abort), api.messages(args.peer_id, args.limit ?? 20, context.abort), active(context.abort)])
        return json({ peerID: args.peer_id, state: running.has(args.peer_id) ? "running" : registry.queueState(args.peer_id) ?? "idle", session, messages })
      }}),
      help_message: tool({ description: "Send an owned peer a follow-up. steer sends immediately; queue atomically persists delivery until idle and capacity is available.", args: { peer_id: tool.schema.string().min(1), message: tool.schema.string().min(1), delivery: tool.schema.enum(["steer", "queue"]) }, async execute(args, context) {
        const peer = owned(context.sessionID, args.peer_id); const id = messageID()
        if (args.delivery === "queue") { registry.enqueue({ id, ownerSessionID: context.sessionID, sessionID: peer.sessionID, text: args.message, agent: peer.agent, model: peer.model }); trigger(); return json({ peerID: peer.sessionID, messageID: id, state: "queued" }) }
        if (!registry.reserve(context.sessionID, peer.sessionID, settings.maxConcurrent, Date.now() + lease)) throw new Error(`Concurrent peer limit reached (${settings.maxConcurrent})`)
        await api.prompt({ sessionID: peer.sessionID, text: args.message, agent: peer.agent, model: peer.model, messageID: id }, context.abort); registry.markActive([peer.sessionID], input.directory, Date.now() + lease)
        return json({ peerID: peer.sessionID, messageID: id, state: "sent" })
      }}),
      help_wait: tool({ description: "Wait a bounded time for an owned peer to become idle. Never waits indefinitely.", args: { peer_id: tool.schema.string().min(1), timeout_seconds: tool.schema.number().int().min(1).max(600).optional() }, async execute(args, context) {
        owned(context.sessionID, args.peer_id); const deadline = Date.now() + (args.timeout_seconds ?? 120) * 1000; let idleSince: number | undefined
        while (Date.now() < deadline) { const running = await active(context.abort); const queue = registry.queueState(args.peer_id); if (queue === "queue_failed") return json({ peerID: args.peer_id, state: queue }); if (running.has(args.peer_id) || queue === "queued") idleSince = undefined; else idleSince ??= Date.now(); if (idleSince && Date.now() - idleSince >= settings.idleSettleMs) return json({ peerID: args.peer_id, state: "idle" }); await sleep(settings.queueIntervalMs, context.abort) }
        return json({ peerID: args.peer_id, state: "timed_out" })
      }}),
      help_close: tool({ description: "Archive and detach an owned help peer. This never deletes an OpenCode session or history.", args: { peer_id: tool.schema.string().min(1) }, async execute(args, context) {
        owned(context.sessionID, args.peer_id); if (!registry.archive(context.sessionID, args.peer_id)) throw new Error("Peer could not be archived"); return json({ peerID: args.peer_id, state: "archived", destructive: false })
      }}),
      help_resume: tool({ description: "Reattach an owned archived peer; it remains the same durable OpenCode session.", args: { peer_id: tool.schema.string().min(1) }, async execute(args, context) {
        if (!owned(context.sessionID, args.peer_id, true).archived) throw new Error("Peer is already active"); if (!registry.resume(context.sessionID, args.peer_id)) throw new Error("Peer could not be resumed"); return json({ peerID: args.peer_id, state: "resumed" })
      }}),
    }, dispose: async () => { clearInterval(timer); shutdown.abort(); await pump?.catch(() => undefined); registry.close() } }
  }
}
export default opencodeHelp()

function resolve(overrides: Options, options: PluginOptions): Settings {
  const defaultModel = parseModel(overrides.defaultModel ?? str(options.defaultModel) ?? "opencode-go/mimo-v2.5")
  if (!defaultModel) throw new Error("defaultModel must be provider/model-id")
  return {
    databasePath: overrides.databasePath ?? str(options.databasePath) ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode-help", "registry.sqlite"),
    maxConcurrent: overrides.maxConcurrent ?? int(options.maxConcurrent, 1, 32) ?? 8,
    queueIntervalMs: overrides.queueIntervalMs ?? int(options.queueIntervalMs, 50, 5_000) ?? 250,
    idleSettleMs: overrides.idleSettleMs ?? int(options.idleSettleMs, 50, 10_000) ?? 500,
    defaultModel,
  }
}
function parseModel(value?: string): ModelSelection | undefined { if (!value) return undefined; const slash = value.indexOf("/"); if (slash < 1 || slash === value.length - 1) throw new Error("model must be provider/model-id"); return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) } }
function int(value: unknown, min: number, max: number) { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined }
function str(value: unknown) { return typeof value === "string" && value.length > 0 ? value : undefined }
function messageID() { return `help_${crypto.randomUUID()}` }
function json(value: unknown) { return JSON.stringify(value, null, 2) }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
function sleep(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => { if (signal.aborted) return reject(signal.reason); const timeout = setTimeout(done, ms); signal.addEventListener("abort", abort, { once: true }); function done() { signal.removeEventListener("abort", abort); resolve() } function abort() { clearTimeout(timeout); reject(signal.reason) } }) }
