import { Command } from "effect/unstable/cli"
import * as Infra from "../../infra"

/**
  * @since 0.0.0
  * @category command
  */
export const deploy = Command.make("deploy", {}, Infra.deploy).pipe(
  Command.withDescription("Deploy Fireclanker to AWS")
)
