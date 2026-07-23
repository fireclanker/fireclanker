import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { execStack } from "alchemy/Cli/commands/deploy"
import { Effect, Option } from "effect"
import * as FileSystem from "effect/FileSystem"
import { readConfig } from "../config.ts"
import { configureAwsSdk } from "./aws-sdk.ts"
import { AlchemyServices } from "./services.ts"

const stackPath = fileURLToPath(new URL("./stack.ts", import.meta.url))
const agentSourcePaths = [
  "./agent-microvm.ts",
  "./Dockerfile",
  "../opencode/bedrock.ts",
  "../opencode/effect-sdk.ts",
  "../opencode/run.ts",
  "../../package.json",
  "../../../../bun.lock"
]

export const deploy = Effect.fn("Infrastructure.deploy")(
  function*() {
    const config = yield* readConfig
    const { profile } = yield* configureAwsSdk(config)
    const fs = yield* FileSystem.FileSystem
    const agentSources = yield* Effect.forEach(agentSourcePaths, (path) =>
      fs.readFile(fileURLToPath(new URL(path, import.meta.url))).pipe(
        Effect.map((content) => ({ path, content }))
      )
    )
    const sourceHash = yield* Effect.sync(() => {
      const hash = createHash("sha256")
      for (const source of agentSources) hash.update(source.path).update(source.content)
      return hash.digest("hex")
    })
    yield* Effect.sync(() => {
      process.env.FIRECLANKER_NAME = config.name
      process.env.FIRECLANKER_AGENT_SOURCE_HASH = sourceHash
    })
    yield* execStack({
      main: stackPath,
      stage: "prod",
      profile,
      envFile: Option.none(),
      yes: true
    })
  },
  Effect.provide(AlchemyServices),
  Effect.scoped
)
