import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { TestConsole } from "effect/testing"
import {
  type IAgentJobRepository,
  AgentJob,
  AgentJobEvent,
  AgentJobId,
  AgentJobRepository,
  AgentJobService,
  AgentJobServiceLive
} from "../src/agent-job/index.ts"

test("watch prints ordered events once before the terminal result", async () => {
  const id = Schema.decodeUnknownSync(AgentJobId)(crypto.randomUUID())
  const now = "2026-07-19T12:00:00.000Z"
  const job = Schema.decodeUnknownSync(AgentJob)({
    id,
    prompt: "hello",
    status: "succeeded",
    createdAt: now,
    startedAt: now,
    completedAt: now,
    result: "echo: hello"
  })
  const events = [1, 2].map((sequence) =>
    Schema.decodeUnknownSync(AgentJobEvent)({
      jobId: id,
      sequence,
      message: `event ${sequence}`,
      createdAt: now
    }))
  const cursors: Array<number> = []
  const repository: IAgentJobRepository = {
    put: () => Effect.void,
    claim: () => Effect.succeed(false),
    appendEvent: () => Effect.void,
    succeed: () => Effect.void,
    fail: () => Effect.void,
    get: () => Effect.succeed(job),
    listEventsAfter: (_id, cursor) => {
      cursors.push(cursor)
      return Effect.succeed(events.filter((event) => event.sequence > cursor))
    }
  }
  const layer = AgentJobServiceLive.pipe(
    Layer.provide(Layer.succeed(AgentJobRepository, repository))
  )

  const lines = await Effect.runPromise(
    Effect.gen(function*() {
      const service = yield* AgentJobService
      yield* service.watchJob(id)
      return yield* TestConsole.logLines
    }).pipe(
      Effect.provide(layer),
      Effect.provide(TestConsole.layer)
    )
  )

  expect(lines).toEqual(["event 1", "event 2", "echo: hello"])
  expect(cursors).toEqual([0, 2])
})
