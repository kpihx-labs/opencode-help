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

test("uses the first configured model by default and permits an explicit listed model", async () => {
  let prompt: unknown
  let peerNumber = 0
  const client = {
    session: {
      create: async () => ({ data: { id: `peer-${++peerNumber}`, title: "Help", directory: "/work", time: { created: 0, updated: 0 } } }),
      message: async () => ({ data: undefined }),
      promptAsync: async (request: unknown) => { prompt = request; return { data: undefined } },
      status: async () => ({ data: {} }),
    },
  }
  const models = ["opencode-go/deepseek-v4-pro", "google/gemini-3.1-pro-preview"]
  const plugin = opencodeHelp({ databasePath: ":memory:", queueIntervalMs: 5_000, models })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  const open = hooks.tool?.help_open
  if (!open) throw new Error("help_open is unavailable")
  await open.execute({ prompt: "review", agent: "executor" }, context as never)
  expect(prompt).toMatchObject({ body: { agent: "executor", model: { providerID: "opencode-go", modelID: "deepseek-v4-pro" } } })
  await open.execute({ prompt: "review again", agent: "executor", model: "google/gemini-3.1-pro-preview" }, context as never)
  expect(prompt).toMatchObject({ body: { agent: "executor", model: { providerID: "google", modelID: "gemini-3.1-pro-preview" } } })
  await hooks.dispose?.()
})

test("exposes the ordered configured model pool in tools and help_list", async () => {
  const models = ["opencode-go/deepseek-v4-pro", "google/gemini-3.1-pro-preview"]
  const client = { session: { status: async () => ({ data: {} }) } }
  const plugin = opencodeHelp({ databasePath: ":memory:", queueIntervalMs: 5_000, models })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const open = hooks.tool?.help_open as { description?: string } | undefined
  const list = hooks.tool?.help_list
  if (!open || !list) throw new Error("help tools are unavailable")
  expect(open.description).toContain("1. opencode-go/deepseek-v4-pro (default)")
  expect(open.description).toContain("2. google/gemini-3.1-pro-preview")
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  expect(JSON.parse(await list.execute({}, context as never))).toMatchObject({ defaultModel: models[0], permittedModels: models, peers: [] })
  await hooks.dispose?.()
})

test("rejects a model outside the configured allowlist before creating a peer", async () => {
  let created = 0
  const client = { session: { create: async () => { created += 1; return { data: { id: "peer-1", title: "Help", directory: "/work", time: { created: 0, updated: 0 } } } }, message: async () => ({ data: undefined }), promptAsync: async () => ({ data: undefined }), status: async () => ({ data: {} }) } }
  const plugin = opencodeHelp({ databasePath: ":memory:", queueIntervalMs: 5_000, models: ["opencode-go/deepseek-v4-pro"] })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const open = hooks.tool?.help_open
  if (!open) throw new Error("help_open is unavailable")
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  await expect(open.execute({ prompt: "review", agent: "executor", model: "google/gemini-3.1-pro-preview" }, context as never)).rejects.toThrow("is not permitted")
  expect(created).toBe(0)
  await hooks.dispose?.()
})

test("archives a failed opening peer and tells the parent to reopen with a permitted model", async () => {
  const client = { session: { create: async () => ({ data: { id: "peer-1", title: "Help", directory: "/work", time: { created: 0, updated: 0 } } }), message: async () => ({ data: undefined }), promptAsync: async () => ({ error: "quota exhausted" }), status: async () => ({ data: {} }) } }
  const plugin = opencodeHelp({ databasePath: ":memory:", queueIntervalMs: 5_000, models: ["opencode-go/deepseek-v4-pro", "google/gemini-3.1-pro-preview"] })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const open = hooks.tool?.help_open
  if (!open) throw new Error("help_open is unavailable")
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  await expect(open.execute({ prompt: "review", agent: "executor" }, context as never)).rejects.toThrow("Explicitly call help_open again with another permitted model: opencode-go/deepseek-v4-pro, google/gemini-3.1-pro-preview")
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
    },
  }
  const plugin = opencodeHelp({ databasePath: ":memory:", maxConcurrent: 1, queueIntervalMs: 5_000, models: ["opencode-go/deepseek-v4-pro"] })
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
