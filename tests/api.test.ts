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

test("lists live agents and configured provider models", async () => {
  const client = {
    agent: { list: async () => ({ data: [{ name: "general", description: "General peer", mode: "subagent" }] }) },
    provider: { list: async () => ({ data: { all: [{ id: "opencode-go", models: { "mimo-v2.5": { name: "Mimo 2.5" } } }], connected: ["opencode-go"] } }) },
  }
  const api = new OpenCodeApi(client as never, "/work")
  await expect(api.catalog()).resolves.toEqual({
    agents: [{ name: "general", description: "General peer", mode: "subagent" }],
    providers: { all: [{ id: "opencode-go", models: { "mimo-v2.5": { name: "Mimo 2.5" } } }], connected: ["opencode-go"] },
  })
})

test("applies configured defaults and exposes unavailable catalog entries", async () => {
  let prompt: unknown
  const client = {
    session: {
      create: async () => ({ data: { id: "peer-1", title: "Help", directory: "/work", time: { created: 0, updated: 0 } } }),
      message: async () => ({ data: undefined }),
      promptAsync: async (request: unknown) => { prompt = request; return { data: undefined } },
      status: async () => ({ data: {} }),
    },
    agent: { list: async () => ({ data: [{ name: "general" }] }) },
    provider: { list: async () => ({ data: { all: [{ id: "opencode-go", models: { "mimo-v2.5": { name: "Mimo 2.5" } } }], connected: [] } }) },
  }
  const plugin = opencodeHelp({ databasePath: ":memory:", queueIntervalMs: 5_000 })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  const open = hooks.tool?.help_open
  const catalog = hooks.tool?.help_catalog
  if (!open || !catalog) throw new Error("help tools are unavailable")
  await open.execute({ prompt: "review" }, context as never)
  expect(prompt).toMatchObject({ body: { agent: "general", model: { providerID: "opencode-go", modelID: "mimo-v2.5" } } })
  await expect(catalog.execute({}, context as never)).resolves.toContain('"reason": "provider_not_connected"')
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
  const plugin = opencodeHelp({ databasePath: ":memory:", maxConcurrent: 1, queueIntervalMs: 5_000 })
  const hooks = await plugin({ client, directory: "/work" } as never)
  const open = hooks.tool?.help_open
  if (!open) throw new Error("help_open is unavailable")
  const context = { sessionID: "parent-a", agent: "build", directory: "/work", abort: new AbortController().signal }
  const first = open.execute({ prompt: "first" }, context as never)
  await expect(open.execute({ prompt: "second" }, context as never)).rejects.toThrow("Concurrent peer limit reached (1)")
  expect(created).toBe(1)
  resolveCreate?.({ data: { id: "peer-1", title: "Help", directory: "/work", time: { created: 0, updated: 0 } } })
  await first
  await hooks.dispose?.()
})
