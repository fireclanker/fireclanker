import { Effect, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

export const ConfigValue = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty()
)

export const DeploymentName = ConfigValue.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9_.-]+$/)
)

export const AwsRegion = ConfigValue.check(
  Schema.isPattern(/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/)
)

export const FireclankerConfig = Schema.Struct({
  name: DeploymentName,
  region: AwsRegion,
  awsProfile: ConfigValue
})

export type FireclankerConfig = typeof FireclankerConfig.Type

const resolveConfigPath = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = yield* Effect.sync(() => process.env.HOME)
  if (!home) return yield* Effect.fail(new Error("HOME is not set"))
  return path.join(home, ".config", "fireclanker", "config.json")
})

export const readConfig = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const configPath = yield* resolveConfigPath
  const contents = yield* fs.readFileString(configPath).pipe(
    Effect.mapError((cause) => new Error(
      `Unable to read ${configPath}. Run 'fireclanker init' first.`,
      { cause }
    ))
  )
  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents),
    catch: (cause) => new Error(`Invalid JSON in ${configPath}`, { cause })
  })
  return yield* Schema.decodeUnknownEffect(FireclankerConfig, {
    onExcessProperty: "error"
  })(parsed).pipe(
    Effect.mapError((cause) => new Error(`Invalid Fireclanker configuration in ${configPath}`, { cause }))
  )
})

export const writeConfig = (input: unknown) => Effect.gen(function*() {
  const config = yield* Schema.decodeUnknownEffect(FireclankerConfig, {
    onExcessProperty: "error"
  })(input).pipe(
    Effect.mapError((cause) => new Error("Invalid Fireclanker configuration", { cause }))
  )
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configPath = yield* resolveConfigPath
  yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
  yield* fs.writeFileString(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return configPath
})
