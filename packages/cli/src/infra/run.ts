import { AgentJob } from "@fireclanker/core"
import { Console, Effect, Layer } from "effect"
import { readConfig } from "../config.ts"
import { configureAwsSdk } from "./aws-sdk.ts"
import { AlchemyServices } from "./services.ts"

export const run = Effect.fn("Infrastructure.run")(
  function*(prompt: string, watch: boolean) {
    const config = yield* readConfig
    const { clientConfig } = yield* configureAwsSdk(config)
    const agentJobLayer = AgentJob.AgentJobServiceLive.pipe(
      Layer.provide(AgentJob.DynamoAgentJobRepository({
        tableName: config.name,
        clientConfig
      }))
    )

    yield* Effect.gen(function*() {
      const service = yield* AgentJob.AgentJobService
      const job = yield* service.queueJob(prompt)
      yield* Console.log(job.id)

      if (watch) yield* service.watchJob(job.id)
    }).pipe(Effect.provide(agentJobLayer))
  },
  Effect.provide(AlchemyServices),
  Effect.scoped
)
