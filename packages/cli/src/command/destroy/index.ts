import { Command } from "effect/unstable/cli"
import * as Infra from "../../infra"

/**
  * @since 0.0.0
  * @category command
  */
export const destroy = Command.make("destroy", {}, Infra.destroy).pipe(
  Command.withDescription("Destroy Fireclanker infrastructure in AWS")
)
