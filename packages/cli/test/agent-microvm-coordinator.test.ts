import { AgentHarness, AgentJob } from "@fireclanker/core"
import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { makeAgentMicrovmCoordinator } from "../src/infra/agent-microvm-coordinator.ts"

const result: AgentHarness.AgentHarnessRunResult = {
  result: "done",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  changes: [],
  publication: {
    kind: "do-not-publish",
    reason: "No changes"
  }
}

test("starts one execution and replays sequenced events to later watchers", async () => {
  let runs = 0
  const harness: AgentHarness.IAgentHarness = {
    run: () => {
      runs++
      return Stream.make(
        { _tag: "log", message: "checkout completed" },
        { _tag: "completed", result }
      )
    }
  }
  const coordinator = makeAgentMicrovmCoordinator(harness)
  const request = {
    prompt: "hello",
    sourceRepository: Schema.decodeUnknownSync(AgentJob.SourceRepository)(
      "fireclanker/example"
    ),
    publicationOptions: []
  }

  const [allEvents, tailEvents] = await Effect.runPromise(
    Effect.gen(function*() {
      yield* coordinator.start(request)
      yield* coordinator.start(request)
      const allEvents = yield* coordinator.events().pipe(Stream.runCollect)
      const tailEvents = yield* coordinator.watch({
        afterSequence: 1
      }).pipe(Stream.runCollect)
      return [Array.from(allEvents), Array.from(tailEvents)] as const
    })
  )

  expect(runs).toBe(1)
  expect(allEvents).toEqual([
    { _tag: "log", sequence: 1, message: "checkout completed" },
    { _tag: "completed", sequence: 2, result }
  ])
  expect(tailEvents).toEqual([
    { _tag: "completed", sequence: 2, result }
  ])
})
