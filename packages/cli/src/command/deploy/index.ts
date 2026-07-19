import { execStack } from "alchemy/Cli/commands/deploy"
import { Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"
import { fileURLToPath } from "node:url"
import { ensureAwsAccountId } from "../../infra/aws-account.ts"
import { AlchemyServices } from "../../infra/services.ts"

const stackPath = fileURLToPath(new URL("../../infra/stack.ts", import.meta.url))

const deployInfrastructure = ensureAwsAccountId.pipe(
  Effect.andThen(execStack({
    main: stackPath,
    stage: "prod",
    envFile: Option.none(),
    yes: true
  })),
  Effect.provide(AlchemyServices),
  Effect.scoped
)

export const deploy = Command.make("deploy", {}, () => deployInfrastructure).pipe(
  Command.withDescription("Deploy Fireclanker to AWS")
)
