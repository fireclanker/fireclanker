import { Command } from "effect/unstable/cli"
import * as Infra from "../../infra"

export const auth = Command.make(
  "auth",
  {},
  Infra.configureOpenAISubscription
).pipe(
  Command.withDescription(
    "Use the local OpenCode ChatGPT subscription for remote runs"
  )
)
