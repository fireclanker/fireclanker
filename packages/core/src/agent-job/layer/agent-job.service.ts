import { Console, DateTime, Effect, Layer, Schema } from "effect"
import * as AgentJobModel from "../agent-job.model.ts"
import {
  AgentJobNotFound,
  AgentJobOperationError,
  InvalidAgentPrompt,
  QueueJobError
} from "../error.ts"
import { AgentJobRepository } from "../service/agent-job.repository.ts"
import {
  AgentJobService,
  type IAgentJobService
} from "../service/agent-job.service.ts"

/**
  * @since
  * @category layer
  */
export const AgentJobServiceLive = Layer.effect(
  AgentJobService,
  Effect.gen(function*() {
    const repository = yield* AgentJobRepository

    /**
      * @since
      * @category layer method
      */
    const queueJob: IAgentJobService["queueJob"] = Effect.fn(
      "AgentJobService.queueJob"
    )(function*(input) {
      const prompt = yield* Schema.decodeUnknownEffect(AgentJobModel.AgentPrompt)(input).pipe(
        Effect.mapError((cause) => new InvalidAgentPrompt({ cause }))
      )
      const { job, createdAtIso } = yield* AgentJobModel.make(prompt)

      yield* repository.put(job, createdAtIso).pipe(
        Effect.mapError((cause) => new QueueJobError({ cause }))
      )

      return job
    })

    const operationError = (cause: unknown) => new AgentJobOperationError({ cause })

    /**
      * @since
      * @category layer method
      */
    const claim: IAgentJobService["claim"] = Effect.fn("AgentJobService.claim")(
      function*(id) {
        const startedAt = yield* DateTime.now
        return yield* repository.claim(id, DateTime.formatIso(startedAt)).pipe(
          Effect.mapError(operationError)
        )
      }
    )

    /**
      * @since
      * @category layer method
      */
    const appendEvent: IAgentJobService["appendEvent"] = Effect.fn(
      "AgentJobService.appendEvent"
    )(function*(id, sequence, message) {
      const createdAt = yield* DateTime.now
      const boundedMessage = message.length <= 8192
        ? message
        : `${message.slice(0, 8179)}[truncated]`
      const event = new AgentJobModel.AgentJobEvent({
        jobId: id,
        sequence,
        message: boundedMessage,
        createdAt
      })
      yield* repository.appendEvent(event, DateTime.formatIso(createdAt)).pipe(
        Effect.mapError(operationError)
      )
      return event
    })

    /**
      * @since
      * @category layer method
      */
    const succeed: IAgentJobService["succeed"] = Effect.fn(
      "AgentJobService.succeed"
    )(function*(id, result) {
      const validResult = yield* Schema.decodeUnknownEffect(AgentJobModel.AgentJobResult)(result).pipe(
        Effect.mapError(operationError)
      )
      const completedAt = yield* DateTime.now
      yield* repository.succeed(id, validResult, DateTime.formatIso(completedAt)).pipe(
        Effect.mapError(operationError)
      )
    })

    /**
      * @since
      * @category layer method
      */
    const fail: IAgentJobService["fail"] = Effect.fn("AgentJobService.fail")(
      function*(id, failure) {
        const validFailure = yield* Schema.decodeUnknownEffect(AgentJobModel.FailureDescription)(failure).pipe(
          Effect.mapError(operationError)
        )
        const completedAt = yield* DateTime.now
        yield* repository.fail(id, validFailure, DateTime.formatIso(completedAt)).pipe(
          Effect.mapError(operationError)
        )
      }
    )

    /**
      * @since
      * @category layer method
      */
    const get: IAgentJobService["get"] = Effect.fn("AgentJobService.get")(
      function*(id) {
        const job = yield* repository.get(id).pipe(Effect.mapError(operationError))
        return yield* job === undefined
          ? Effect.fail(new AgentJobNotFound({ id }))
          : Effect.succeed(job)
      }
    )

    /**
      * @since
      * @category layer method
      */
    const listEventsAfter: IAgentJobService["listEventsAfter"] = Effect.fn(
      "AgentJobService.listEventsAfter"
    )((id, sequence) => repository.listEventsAfter(id, sequence).pipe(
      Effect.mapError(operationError)
    ))

    /**
      * @since
      * @category layer method
      */
    const watchJob: IAgentJobService["watchJob"] = Effect.fn(
      "AgentJobService.watchJob"
    )(function*(id) {
      let cursor = 0
      const drainEvents = Effect.fn("AgentJobService.watchJob.drainEvents")(function*() {
        const events = yield* listEventsAfter(id, cursor)
        for (const event of events) {
          yield* Console.log(event.message)
          cursor = event.sequence
        }
      })

      while (true) {
        yield* drainEvents()

        const current = yield* get(id)
        if (current.status === "succeeded") {
          yield* drainEvents()
          yield* Console.log(current.result)
          return
        }
        if (current.status === "failed") {
          yield* drainEvents()
          return yield* Effect.fail(new Error(current.failure))
        }

        yield* Effect.sleep("1 second")
      }
    })

    return AgentJobService.of({
      queueJob,
      claim,
      appendEvent,
      succeed,
      fail,
      get,
      listEventsAfter,
      watchJob
    })
  })
)
