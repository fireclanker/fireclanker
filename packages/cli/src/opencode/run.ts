import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeOpenCode, OpenCodeError, type OpenCodePart } from "./effect-sdk.ts"
import { mockModel, mockOpencodeConfig, startMockLlm } from "./mock-llm.ts"

export const runOpencodeWithMock = Effect.fn("OpenCode.runWithMock")(
  function*(prompt: string) {
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "fireclanker-")),
        catch: (cause) => new OpenCodeError({ operation: "create-temporary-directory", cause })
      }),
      (root) => Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: (cause) => new OpenCodeError({ operation: "remove-temporary-directory", cause })
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning(
          "Unable to remove temporary OpenCode directory",
          cause
        ))
      )
    )
    const workspace = join(root, "workspace")
    yield* Effect.tryPromise({
      try: () => mkdir(workspace),
      catch: (cause) => new OpenCodeError({ operation: "create-workspace", cause })
    })
    const llm = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => startMockLlm(`mock response: ${prompt}`),
        catch: (cause) => new OpenCodeError({ operation: "start-mock-llm", cause })
      }),
      (llm) => Effect.tryPromise({
        try: () => llm.close(),
        catch: (cause) => new OpenCodeError({ operation: "stop-mock-llm", cause })
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Unable to stop mock LLM", cause))
      )
    )
    const opencode = yield* makeOpenCode({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 30_000,
      config: mockOpencodeConfig(llm.baseURL)
    })

    const session = yield* opencode.session.create({
      directory: workspace,
      title: "Fireclanker mock run",
      model: { providerID: mockModel.providerID, id: mockModel.modelID }
    })
    const response = yield* opencode.session.prompt({
      sessionID: session.id,
      directory: workspace,
      model: mockModel,
      parts: [{ type: "text", text: prompt }]
    })
    const result = response.parts
      .filter((part): part is OpenCodePart & { readonly text: string } =>
        part.type === "text" && part.ignored !== true && typeof part.text === "string"
      )
      .map((part) => part.text)
      .join("\n")

    if (!result.trim()) {
      return yield* Effect.fail(new OpenCodeError({
        operation: "read-prompt-response",
        cause: new Error("OpenCode returned no text response")
      }))
    }
    return result
  },
  Effect.scoped,
  Effect.timeout("180 seconds")
)
