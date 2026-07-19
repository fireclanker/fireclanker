import { Effect, Layer, Schema } from "effect"
import { AgentPrompt, make as makeAgentJob } from "../agent-job.model.ts"
import { InvalidAgentPrompt, QueueJobError } from "../error.ts"
import { AgentJobRepository } from "../repository/agent-job.repository.ts"
import {
  AgentJobService,
  type IAgentJobService
} from "../service/agent-job.service.ts"

export const AgentJobServiceLive = Layer.effect(
  AgentJobService,
  Effect.gen(function*() {
    const repository = yield* AgentJobRepository

    const queueJob: IAgentJobService["queueJob"] = Effect.fn(
      "AgentJobService.queueJob"
    )(function*(input) {
      const prompt = yield* Schema.decodeUnknownEffect(AgentPrompt)(input).pipe(
        Effect.mapError((cause) => new InvalidAgentPrompt({ cause }))
      )
      const { job, createdAtIso } = yield* makeAgentJob(prompt)

      yield* repository.put(job, createdAtIso).pipe(
        Effect.mapError((cause) => new QueueJobError({ cause }))
      )

      return job
    })

    return AgentJobService.of({ queueJob })
  })
)
