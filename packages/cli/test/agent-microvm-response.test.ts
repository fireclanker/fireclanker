import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import {
  consumeAgentMicrovmStream,
  requireAgentMicrovmResponse
} from "../src/infra/agent-microvm-response.ts"

test("rejects a missing response from an expired agent microVM", async () => {
  const error = await Effect.runPromise(
    requireAgentMicrovmResponse(null).pipe(Effect.flip)
  )

  expect(error).toEqual({
    _tag: "AgentMicrovmError",
    operation: "await-agent-response"
  })
})

const result = {
  result: "done",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  changes: [],
  publication: {
    kind: "do-not-publish" as const,
    reason: "No changes to publish"
  }
}

test("persists streamed logs before returning the terminal response", async () => {
  const logs: Array<string> = []
  const response = await Effect.runPromise(consumeAgentMicrovmStream(
    Stream.make(
      { _tag: "log" as const, sequence: 1, message: "checkout completed" },
      { _tag: "log" as const, sequence: 2, message: "agent completed" },
      { _tag: "completed" as const, sequence: 3, result }
    ),
    (message) => Effect.sync(() => {
      logs.push(message)
    })
  ))

  expect(logs).toEqual(["checkout completed", "agent completed"])
  expect(response).toEqual(result)
})

test("rejects logs after the terminal stream event", async () => {
  const error = await Effect.runPromise(consumeAgentMicrovmStream(
    Stream.make(
      { _tag: "completed" as const, sequence: 1, result },
      { _tag: "log" as const, sequence: 2, message: "too late" }
    ),
    () => Effect.void
  ).pipe(Effect.flip))

  expect(error).toEqual({
    _tag: "AgentMicrovmError",
    operation: "read-agent-stream"
  })
})

test("rejects a gap in the microVM event sequence", async () => {
  const error = await Effect.runPromise(consumeAgentMicrovmStream(
    Stream.make(
      { _tag: "log" as const, sequence: 2, message: "missing event" },
      { _tag: "completed" as const, sequence: 3, result }
    ),
    () => Effect.void
  ).pipe(Effect.flip))

  expect(error).toEqual({
    _tag: "AgentMicrovmError",
    operation: "read-agent-stream"
  })
})
