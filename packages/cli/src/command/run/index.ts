import { AgentJob } from "@fireclanker/core"
import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as Infra from "../../infra"

const prompt = Argument.string("prompt").pipe(
  Argument.withDescription("Prompt for the agent job")
)

const watch = Flag.boolean("watch").pipe(
  Flag.withDescription("Stream live job output until completion")
)

const repo = Flag.string("repo").pipe(
  Flag.withSchema(AgentJob.SourceRepositoryArgument),
  Flag.withDescription("GitHub Source Repository in owner/name[@branch] format")
)

/**
  * @since 0.0.0
  * @category command
  */
export const run = Command.make("run", { prompt, watch, repo }, Effect.fn(function*({ prompt, watch, repo }) {
  yield* Infra.run(prompt, repo, watch)
})).pipe(
  Command.withDescription("Queue an agent job")
)
