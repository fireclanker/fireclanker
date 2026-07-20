import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

const providerId = "test"
const modelId = "test-model"

export const mockModel = {
  providerID: providerId,
  modelID: modelId
} as const

export const mockOpencodeConfig = (baseURL: string): Record<string, unknown> => ({
  autoupdate: false,
  share: "disabled" as const,
  formatter: false,
  lsp: false,
  model: `${providerId}/${modelId}`,
  small_model: `${providerId}/${modelId}`,
  enabled_providers: [providerId],
  provider: {
    [providerId]: {
      id: providerId,
      name: "Test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        [modelId]: {
          id: modelId,
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {}
        }
      },
      options: { apiKey: "test-key", baseURL }
    }
  }
})

export const startMockLlm = async (text: string): Promise<{
  readonly baseURL: string
  readonly close: () => Promise<void>
}> => {
  const server = createServer((request, response) => {
    request.resume()
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end()
      return
    }

    const chunks = [
      chunk({ role: "assistant" }),
      chunk({ content: text }),
      {
        id: "chatcmpl-fireclanker",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }
    ]

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream"
    })
    response.end(`${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.close()
      reject(error)
    }
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resolve()
    })
  })

  const address = server.address() as AddressInfo | null
  if (!address) {
    server.close()
    throw new Error("Mock LLM did not bind to a TCP port")
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    )
  }
}

const chunk = (delta: Record<string, unknown>): Record<string, unknown> => ({
  id: "chatcmpl-fireclanker",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta }]
})
