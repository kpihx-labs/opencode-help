import { expect, test } from "bun:test"
import { OpenCodeApi } from "../src/api.js"
import { opencodeHelp } from "../src/index.js"

test("sends the selected model directly on promptAsync", async () => {
  let received: unknown
  const client = {
    session: {
      message: async () => ({ data: undefined }),
      promptAsync: async (request: unknown) => { received = request; return { data: undefined } },
    },
  }
  const api = new OpenCodeApi(client as never, "/work")
  await api.prompt({ sessionID: "peer-1", text: "review", agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, messageID: "message-1" })
  expect(received).toMatchObject({ body: { agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, parts: [{ type: "text", text: "review" }] } })
})

test("preserves structured OpenCode prompt errors", async () => {
  const client = {
    session: {
      message: async () => ({ data: undefined }),
      promptAsync: async () => ({ error: { status: 400, message: "Unknown model" } }),
    },
  }
  const api = new OpenCodeApi(client as never, "/work")
  await expect(api.prompt({ sessionID: "peer-1", text: "review", agent: "build", messageID: "message-1" }))
    .rejects.toThrow('{"status":400,"message":"Unknown model"}')
})

test("lists only OpenCode-delegable agents", async () => {
  const client = {
    agent: { list: async () => ({ data: [{ name: "Live", mode: "primary" }, { name: "executor", mode: "subagent" }, { name: "general", mode: "all" }] }) },
  }
  const api = new OpenCodeApi(client as never, "/work")
  await expect(api.delegableAgents()).resolves.toEqual(["executor", "general"])
})

test("requires an explicit delegable agent and applies only the configured model", async () => {
  let prompt: unknown
  const client = {
    session: {
      create: async () => ({ data: { id: "peer-1", title: "Help", directory: "/work", time: { created: 0, updated: 0 } } }),
      message: async () => ({ data: undefined }),
      promptAsync: async (request: unknown) => { prompt = request; return { data: undefined } },
      status: async () => ({ data: {} }),
    },
    agent: { list: async () => ({ data: [{ name: "executor", mode: "subagent" }] }) },
  }
  const plugin = opencodeHelp({ databasePath: ":memory:", queueIntervalMs: 5_000 })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  const open = hooks.tool?.help_open
  if (!open) throw new Error("help_open is unavailable")
  await open.execute({ prompt: "review", agent: "executor" }, context as never)
  expect(prompt).toMatchObject({ body: { agent: "executor", model: { providerID: "opencode-go", modelID: "mimo-v2.5" } } })
  await hooks.dispose?.()
})

test("rejects primary-only agents before creating a session", async () => {
  let created = 0
  const client = {
    session: { create: async () => { created += 1; return { data: {} } }, message: async () => ({ data: undefined }), promptAsync: async () => ({ data: undefined }), status: async () => ({ data: {} }) },
    agent: { list: async () => ({ data: [{ name: "Live", mode: "primary" }] }) },
  }
  const hooks = await opencodeHelp({ databasePath: ":memory:", queueIntervalMs: 5_000 })({ client, directory: "/work" } as never)
  const open = hooks.tool?.help_open
  if (!open) throw new Error("help_open is unavailable")
  const context = { sessionID: "parent-a", agent: "Live", directory: "/work", abort: new AbortController().signal }
  await expect(open.execute({ prompt: "review", agent: "Live" }, context as never)).rejects.toThrow("not an OpenCode-delegable subagent")
  expect(created).toBe(0)
  await hooks.dispose?.()
})

test("rejects saturated help_open before creating another OpenCode session", async () => {
  let created = 0
  let resolveCreate: ((value: unknown) => void) | undefined
  const client = {
    session: {
      create: async () => new Promise((resolve) => { created += 1; resolveCreate = resolve }),
      message: async () => ({ data: undefined }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
    }, agent: { list: async () => ({ data: [{ name: "executor", mode: "subagent" }] }) },
  }
  const plugin = opencodeHelp({ databasePath: ":memory:", maxConcurrent: 1, queueIntervalMs: 5_000 })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const open = hooks.tool?.help_open
  if (!open) throw new Error("help_open is unavailable")
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  const first = open.execute({ prompt: "first", agent: "executor" }, context as never)
  await expect(open.execute({ prompt: "second", agent: "executor" }, context as never)).rejects.toThrow("Concurrent peer limit reached (1)")
  expect(created).toBe(1)
  resolveCreate?.({ data: { id: "peer-1", title: "Help", directory: "/work", time: { created: 0, updated: 0 } } })
  await first
  await hooks.dispose?.()
})
