import { AgentJob } from "@fireclanker/core"
import { Console, Effect, Layer } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { TABLE_NAME } from "../../infra/constants.ts"

const prompt = Argument.string("prompt").pipe(
  Argument.withDescription("Prompt for the agent job")
)

const queueJob = Effect.fn("RunCommand.queueJob")(function*(prompt: string) {
  const agentJobLayer = AgentJob.AgentJobServiceLive.pipe(
    Layer.provide(AgentJob.DynamoAgentJobRepository({ tableName: TABLE_NAME }))
  )

  return yield* AgentJob.AgentJobService.pipe(
    Effect.flatMap((service) => service.queueJob(prompt)),
    Effect.provide(agentJobLayer)
  )
})

export const run = Command.make("run", { prompt }, ({ prompt }) =>
  queueJob(prompt).pipe(
    Effect.tap((job) => Console.log(job.id))
  )
).pipe(
  Command.withDescription("Queue an agent job")
)
