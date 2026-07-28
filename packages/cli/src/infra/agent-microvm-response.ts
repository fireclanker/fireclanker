import { Effect } from "effect"

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
