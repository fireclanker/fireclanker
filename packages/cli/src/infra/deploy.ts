import { execStack } from "alchemy/Cli/commands/deploy"
import { Effect, Option } from "effect"
import { fileURLToPath } from "node:url"
import { configureAwsSdk } from "./aws-sdk.ts"
import { AlchemyServices } from "./services.ts"

const stackPath = fileURLToPath(new URL("./stack.ts", import.meta.url))

export const deploy = Effect.fn("Infrastructure.deploy")(
  function*() {
    const { profile } = yield* configureAwsSdk
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
