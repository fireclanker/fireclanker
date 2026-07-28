import type { AgentHarness } from "@fireclanker/core"
import { Effect, Stream } from "effect"
import type { AgentMicrovmEvent } from "./agent-microvm-rpc.ts"

export type AgentMicrovmError = {
  readonly _tag: "AgentMicrovmError"
  readonly operation: string
  readonly reason?: string
}

export const requireAgentMicrovmResponse = <A>(
  response: A | null | undefined
): Effect.Effect<A, AgentMicrovmError> => response == null
  ? Effect.fail({
    _tag: "AgentMicrovmError",
    operation: "await-agent-response"
  })
  : Effect.succeed(response)

const protocolError = (): AgentMicrovmError => ({
  _tag: "AgentMicrovmError",
  operation: "read-agent-stream"
})

export const consumeAgentMicrovmStream = <StreamError, StreamContext, E, R>(
  stream: Stream.Stream<AgentMicrovmEvent, StreamError, StreamContext>,
  onLog: (message: string, sequence: number) => Effect.Effect<void, E, R>,
  afterSequence = 0
): Effect.Effect<
  AgentHarness.AgentHarnessRunResult,
  AgentMicrovmError | StreamError | E,
  StreamContext | R
> => Effect.gen(function*() {
  let result: AgentHarness.AgentHarnessRunResult | undefined
  let sequence = afterSequence

  const handleEvent = (
    event: AgentMicrovmEvent
  ): Effect.Effect<void, AgentMicrovmError | E, R> => {
    if (event.sequence !== sequence + 1) return Effect.fail(protocolError())
    sequence = event.sequence
    if (event._tag === "log") {
      return result === undefined
        ? onLog(event.message, event.sequence)
        : Effect.fail(protocolError())
    }
    if (event._tag === "failed") return Effect.fail(event.error)
    if (result !== undefined) return Effect.fail(protocolError())
    result = event.result
    return Effect.void
  }

  yield* stream.pipe(Stream.runForEach(handleEvent))

  return yield* requireAgentMicrovmResponse(result)
})
