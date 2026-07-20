import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as Infra from "../../infra"

const prompt = Argument.string("prompt").pipe(
  Argument.withDescription("Prompt for the agent job")
)

const watch = Flag.boolean("watch").pipe(
  Flag.withDescription("Stream persisted job output until completion")
)

/**
  * @since 0.0.0
  * @category command
  */
export const run = Command.make("run", { prompt, watch }, Effect.fn(function*({ prompt, watch }) {
  yield* Infra.run(prompt, watch)
})).pipe(
  Command.withDescription("Queue an agent job")
)
