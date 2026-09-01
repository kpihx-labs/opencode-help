import { afterEach, describe, expect, test } from "bun:test"
import { HelpRegistry } from "../src/registry.js"

let registry: HelpRegistry | undefined
afterEach(() => registry?.close())
function makeRegistry() { registry = new HelpRegistry(":memory:"); return registry }
function peer(overrides = {}) { return { ownerSessionID: "parent-a", sessionID: "peer-1", directory: "/work", agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, ...overrides } }

describe("durable lifecycle registry", () => {
  test("persists ownership, agent and direct prompt model", () => {
    const db = makeRegistry(); db.add(peer())
    expect(db.owned("parent-a", "peer-1")).toMatchObject({ agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, archived: false })
    expect(db.owned("parent-b", "peer-1")).toBeUndefined()
  })
  test("archives without deleting and resumes only for owner", () => {
    const db = makeRegistry(); db.add(peer())
    expect(db.archive("parent-a", "peer-1")).toBe(true)
    expect(db.owned("parent-a", "peer-1")).toBeUndefined()
    expect(db.owned("parent-a", "peer-1", true)?.archived).toBe(true)
    expect(db.resume("parent-b", "peer-1")).toBe(false)
    expect(db.resume("parent-a", "peer-1")).toBe(true)
    expect(db.owned("parent-a", "peer-1")?.archived).toBe(false)
  })
  test("enforces owner-scoped safe concurrency", () => {
    const db = makeRegistry(); db.add(peer()); db.add(peer({ sessionID: "peer-2" }))
    expect(db.reserve("parent-a", "peer-1", 1, Date.now() + 10_000)).toBe(true)
    expect(db.admit("parent-a", 1, Date.now() + 10_000)).toBeUndefined()
    expect(db.reserve("parent-a", "peer-2", 1, Date.now() + 10_000)).toBe(false)
  })
  test("durably queues, atomically claims, and marks delivery", () => {
    const db = makeRegistry(); db.add(peer())
    db.enqueue({ id: "message-1", ownerSessionID: "parent-a", sessionID: "peer-1", text: "continue", agent: "build", model: { providerID: "openai", modelID: "gpt-5" } })
    expect(db.pending("/work")).toHaveLength(1)
    expect(db.claim("message-1", 2, Date.now() + 10_000)).toBe(true)
    expect(db.claim("message-1", 2, Date.now() + 10_000)).toBe(false)
    db.sent("message-1")
    expect(db.queueState("peer-1")).toBeUndefined()
  })
  test("excludes archived peers from pending dispatch", () => {
    const db = makeRegistry(); db.add(peer()); db.enqueue({ id: "message-1", ownerSessionID: "parent-a", sessionID: "peer-1", text: "continue", agent: "build" }); db.archive("parent-a", "peer-1")
    expect(db.pending("/work")).toHaveLength(0)
  })
})
