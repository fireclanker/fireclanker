import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { AgentJob } from "@fireclanker/core"
import {
  type AgentJobLiveFeed,
  watchAgentJob
} from "../src/infra/agent-job-watch.ts"

test("uses the live microVM feed without replaying its persisted events", async () => {
  const id = Schema.decodeUnknownSync(AgentJob.AgentJobId)(crypto.randomUUID())
  const now = "2026-07-28T12:00:00.000Z"
  const running = Schema.decodeUnknownSync(AgentJob.AgentJob)({
    id,
    prompt: "hello",
    status: "running",
    createdAt: now,
    startedAt: now,
    microvmId: "microvm-123",
    microvmEndpoint: "microvm.lambda.example",
    microvmEventBaseSequence: 1
  })
  const succeeded = Schema.decodeUnknownSync(AgentJob.AgentJob)({
    id,
    prompt: "hello",
    status: "succeeded",
    createdAt: now,
    startedAt: now,
    completedAt: now,
    result: "agent response"
  })
  const persisted = [
    "[lambda] agent microvm is running",
    "[microvm] checkout completed",
    "[lambda] published https://example.test/pull/1"
  ].map((message, index) =>
    Schema.decodeUnknownSync(AgentJob.AgentJobEvent)({
      jobId: id,
      sequence: index + 1,
      message,
      createdAt: now
    }))

  let getCalls = 0
  let liveOpened = false
  const service: AgentJob.IAgentJobService = {
    queueJob: () => Effect.die("unused"),
    claim: () => Effect.die("unused"),
    appendEvent: () => Effect.die("unused"),
    attachMicrovm: () => Effect.die("unused"),
    succeed: () => Effect.die("unused"),
    fail: () => Effect.die("unused"),
    get: () => Effect.sync(() => getCalls++ === 0 ? running : succeeded),
    listEventsAfter: (_id, cursor) => Effect.succeed(
      persisted.filter((event) =>
        event.sequence > cursor &&
        (liveOpened ? true : event.sequence === 1)
      )
    ),
    watchJob: () => Effect.die("unused")
  }
  const liveFeed: AgentJobLiveFeed = {
    open: (_job, afterSequence) => {
      expect(afterSequence).toBe(0)
      liveOpened = true
      return Stream.make(
        {
          _tag: "log" as const,
          sequence: 1,
          message: "[microvm] checkout completed"
        },
        {
          _tag: "completed" as const,
          sequence: 2,
          result: {
            result: "agent response",
            baseSha: "0123456789abcdef0123456789abcdef01234567",
            changes: [],
            publication: {
              kind: "do-not-publish" as const,
              reason: "No changes"
            }
          }
        }
      )
    }
  }

  const lines = await Effect.runPromise(
    Effect.gen(function*() {
      yield* watchAgentJob(id, liveFeed)
      return yield* TestConsole.logLines
    }).pipe(
      Effect.provideService(AgentJob.AgentJobService, service),
      Effect.provide(TestConsole.layer)
    )
  )

  expect(lines).toEqual([
    "[lambda] agent microvm is running",
    "[microvm] checkout completed",
    "agent response",
    "[lambda] published https://example.test/pull/1",
  ])
})
