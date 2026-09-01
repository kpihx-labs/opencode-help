import { expect, test } from "bun:test"
import { OpenCodeApi } from "../src/api.js"

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
