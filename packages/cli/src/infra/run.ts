import { AgentJob } from "@fireclanker/core"
import { Console, Effect, Layer } from "effect"
import { readConfig } from "../config.ts"
import { configureAwsSdk } from "./aws-sdk.ts"
import {
  MicrovmAgentJobLiveFeed,
  watchAgentJob
} from "./agent-job-watch.ts"
import { AlchemyServices } from "./services.ts"

export const run = Effect.fn("Infrastructure.run")(
  function*(
    prompt: string,
    sourceRepositoryArgument: AgentJob.SourceRepositoryArgument,
    watch: boolean
  ) {
    const { sourceBranch, sourceRepository } =
      AgentJob.parseSourceRepositoryArgument(sourceRepositoryArgument)
    const config = yield* readConfig
    const { clientConfig, credentials } = yield* configureAwsSdk(config)
    const agentJobLayer = AgentJob.AgentJobServiceLive.pipe(
      Layer.provide(AgentJob.DynamoAgentJobRepository({
        tableName: config.name,
        clientConfig
      }))
    )

    yield* Effect.gen(function*() {
      const service = yield* AgentJob.AgentJobService
      const job = yield* service.queueJob({
        prompt,
        sourceRepository,
        sourceBranch
      })
      yield* Console.log(job.id)

      if (watch) {
        yield* watchAgentJob(
          job.id,
          MicrovmAgentJobLiveFeed({
            region: config.region,
            credentials
          })
        )
      }
    }).pipe(Effect.provide(agentJobLayer))
  },
  Effect.provide(AlchemyServices),
  Effect.scoped
)
