import { expect, test } from "bun:test"
import { mockOpencodeConfig, startMockLlm } from "../src/opencode/mock-llm.ts"

test("serves an OpenAI-compatible streaming response", async () => {
  const llm = await startMockLlm("mock response")

  try {
    const response = await fetch(`${llm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] })
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await response.text()
    expect(body).toContain('"content":"mock response"')
    expect(body).toContain("data: [DONE]")
  } finally {
    await llm.close()
  }
})

test("rejects requests outside the chat completions endpoint", async () => {
  const llm = await startMockLlm("mock response")

  try {
    expect((await fetch(`${llm.baseURL}/models`)).status).toBe(404)
  } finally {
    await llm.close()
  }
})

test("restricts OpenCode to the mock provider", () => {
  const config = mockOpencodeConfig("http://127.0.0.1:1234/v1")

  expect(config.model).toBe("test/test-model")
  expect(config.small_model).toBe("test/test-model")
  expect(config.enabled_providers).toEqual(["test"])
  expect((config.provider as { test: { options: unknown } }).test.options).toEqual({
    apiKey: "test-key",
    baseURL: "http://127.0.0.1:1234/v1"
  })
})
