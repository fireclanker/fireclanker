import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { ParseError } from "@distilled.cloud/aws/Errors"
import { execStack } from "alchemy/Cli/commands/deploy"
import { Effect, Option, Schedule } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { readConfig } from "../config.ts"
import { configureAwsSdk } from "./aws-sdk.ts"
import { ensureGitHubAppCredentials } from "./github-app-credentials.ts"
import { AlchemyServices } from "./services.ts"

const stackPath = fileURLToPath(new URL("./stack.ts", import.meta.url))
const agentSourceFiles = [
  "./agent-microvm.ts",
  "./Dockerfile",
  "../../package.json",
  "../../../core/package.json",
  "../../../../bun.lock"
]
const agentSourceDirectories = ["../../../core/src"]

const transientAwsGatewayResponse = /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/

export const retryTransientAwsGatewayErrors = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => effect.pipe(
  Effect.retry({
    while: (error) => error instanceof ParseError && transientAwsGatewayResponse.test(error.message),
    schedule: Schedule.exponential("250 millis"),
    times: 2
  })
)

export const deploy = Effect.fn("Infrastructure.deploy")(
  function*() {
    const config = yield* readConfig
    const { clientConfig, profile } = yield* configureAwsSdk(config)
    const githubApp = yield* ensureGitHubAppCredentials(config, { clientConfig })
    if (githubApp.created) {
      yield* Effect.logInfo("Install the GitHub App on the repositories Fireclanker may access", {
        installationUrl: githubApp.installationUrl
      })
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files = yield* Effect.forEach(agentSourceFiles, (sourcePath) =>
      fs.readFile(fileURLToPath(new URL(sourcePath, import.meta.url))).pipe(
        Effect.map((content) => ({ path: sourcePath, content }))
      )
    )
    const directories = yield* Effect.forEach(agentSourceDirectories, (sourceDirectory) =>
      Effect.gen(function*() {
        const absoluteDirectory = fileURLToPath(new URL(sourceDirectory, import.meta.url))
        const entries = yield* fs.readDirectory(absoluteDirectory, { recursive: true })
        const sources = yield* Effect.forEach(entries.sort(), (entry) =>
          Effect.gen(function*() {
            const absolutePath = path.join(absoluteDirectory, entry)
            const info = yield* fs.stat(absolutePath)
            if (info.type !== "File") return undefined
            const content = yield* fs.readFile(absolutePath)
            return { path: path.join(sourceDirectory, entry), content }
          })
        )
        return sources.filter((source) => source !== undefined)
      })
    )
    const agentSources = [...files, ...directories.flat()]
      .sort((left, right) => left.path.localeCompare(right.path))
    const sourceHash = yield* Effect.sync(() => {
      const hash = createHash("sha256")
      for (const source of agentSources) hash.update(source.path).update(source.content)
      return hash.digest("hex")
    })
    yield* Effect.sync(() => {
      process.env.FIRECLANKER_NAME = config.name
      process.env.FIRECLANKER_AGENT_SOURCE_HASH = sourceHash
    })
    yield* retryTransientAwsGatewayErrors(execStack({
      main: stackPath,
      stage: "prod",
      profile,
      envFile: Option.none(),
      yes: true
    }))
  },
  Effect.provide(AlchemyServices),
  Effect.scoped
)
