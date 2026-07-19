import { execStack } from "alchemy/Cli/commands/deploy"
import { Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { fileURLToPath } from "node:url"
import { ensureAwsAccountId } from "../../infra/aws-account.ts"
import { AlchemyServices } from "../../infra/services.ts"

const stackPath = fileURLToPath(new URL("../../infra/stack.ts", import.meta.url))

const yes = Flag.boolean("yes").pipe(
  Flag.withDescription("Skip the destruction confirmation")
)

const destroyInfrastructure = (yes: boolean) => ensureAwsAccountId.pipe(
  Effect.andThen(execStack({
    main: stackPath,
    stage: "prod",
    envFile: Option.none(),
    yes,
    destroy: true
  })),
  Effect.provide(AlchemyServices),
  Effect.scoped
)

export const destroy = Command.make("destroy", { yes }, ({ yes }) =>
  destroyInfrastructure(yes)
).pipe(
  Command.withDescription("Destroy Fireclanker infrastructure in AWS")
)
