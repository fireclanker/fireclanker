import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { Effect } from "effect"
import { bedrockModel, bedrockOpencodeConfig } from "./bedrock.ts"
import { makeOpenCode, OpenCodeError, type OpenCodePart } from "./effect-sdk.ts"

export const runOpencode = Effect.fn("OpenCode.run")(
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
    const credentials = yield* Effect.tryPromise({
      try: () => fromNodeProviderChain()(),
      catch: (cause) => new OpenCodeError({ operation: "resolve-aws-credentials", cause })
    })
    const previousCredentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
    yield* Effect.sync(() => {
      process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId
      process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey
      if (credentials.sessionToken) process.env.AWS_SESSION_TOKEN = credentials.sessionToken
      else delete process.env.AWS_SESSION_TOKEN
    })
    const opencode = yield* makeOpenCode({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 30_000,
      config: bedrockOpencodeConfig(
        process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        restoreEnvironment("AWS_ACCESS_KEY_ID", previousCredentials.accessKeyId)
        restoreEnvironment("AWS_SECRET_ACCESS_KEY", previousCredentials.secretAccessKey)
        restoreEnvironment("AWS_SESSION_TOKEN", previousCredentials.sessionToken)
      }))
    )

    const session = yield* opencode.session.create({
      directory: workspace,
      title: "Fireclanker run",
      model: { providerID: bedrockModel.providerID, id: bedrockModel.modelID }
    })
    const response = yield* opencode.session.prompt({
      sessionID: session.id,
      directory: workspace,
      model: bedrockModel,
      parts: [{ type: "text", text: prompt }]
    })
    const result = response.parts
      .filter((part): part is OpenCodePart & { readonly text: string } =>
        part.type === "text" && part.ignored !== true && typeof part.text === "string"
      )
      .map((part) => part.text)
      .join("\n")

    if (response.info.error) {
      return yield* Effect.fail(new OpenCodeError({
        operation: "prompt-response",
        cause: response.info.error
      }))
    }
    if (!result.trim()) {
      return yield* Effect.fail(new OpenCodeError({
        operation: "read-prompt-response",
        cause: new Error("OpenCode returned no text response")
      }))
    }
    return result
  },
  Effect.scoped
)

const restoreEnvironment = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
