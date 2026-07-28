import { expect, test } from "bun:test"
import { Effect } from "effect"
import { requireAgentMicrovmResponse } from "../src/infra/agent-microvm-response.ts"

test("rejects a missing response from an expired agent microVM", async () => {
  const error = await Effect.runPromise(
    requireAgentMicrovmResponse(null).pipe(Effect.flip)
  )

  expect(error).toEqual({
    _tag: "AgentMicrovmError",
    operation: "await-agent-response"
  })
})
