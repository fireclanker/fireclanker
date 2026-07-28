import type { AgentHarness } from "@fireclanker/core"
import { Effect, Queue, Redacted, Stream } from "effect"
import type {
  AgentMicrovmEvent,
  AgentMicrovmRunRequest,
  AgentMicrovmShape
} from "./agent-microvm-rpc.ts"

const errorReason = (cause: unknown): string | undefined => {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`.slice(0, 512)
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message.slice(0, 512)
  }
  return undefined
}

export const makeAgentMicrovmCoordinator = (
  agentHarness: AgentHarness.IAgentHarness
): AgentMicrovmShape => {
  const history: Array<AgentMicrovmEvent> = []
  const listeners = new Set<{
    readonly offer: (event: AgentMicrovmEvent) => void
    readonly end: () => void
  }>()
  let started = false
  let ended = false
  let sequence = 0
  const historyLimit = 1024

  const publish = (event: AgentMicrovmEvent) => Effect.sync(() => {
    history.push(event)
    if (history.length > historyLimit) history.shift()
    for (const listener of listeners) listener.offer(event)
    if (event._tag !== "log") {
      ended = true
      for (const listener of listeners) listener.end()
      listeners.clear()
    }
  })

  const watch = (
    afterSequence: number,
    direct: boolean
  ): Stream.Stream<AgentMicrovmEvent> =>
    Stream.callback<AgentMicrovmEvent>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = {
              offer: (event: AgentMicrovmEvent) => {
                Queue.offerUnsafe(queue, event)
              },
              end: () => {
                Queue.endUnsafe(queue)
              }
            }
            const firstSequence = history[0]?.sequence
            if (
              firstSequence !== undefined &&
              afterSequence < firstSequence - 1
            ) {
              listener.offer({
                _tag: "failed",
                sequence: afterSequence + 1,
                error: {
                  _tag: "AgentMicrovmError",
                  operation: "replay-agent-stream"
                }
              })
              listener.end()
              return listener
            }
            for (const event of history) {
              if (event.sequence > afterSequence) listener.offer(event)
            }
            if (ended) listener.end()
            else listeners.add(listener)
            return listener
          }),
          (listener) => Effect.sync(() => {
            listeners.delete(listener)
          })
        ).pipe(Effect.andThen(Effect.never)),
      direct
        ? { bufferSize: 256, strategy: "dropping" }
        : undefined
    )

  const start = (request: AgentMicrovmRunRequest) => Effect.gen(function*() {
    if (started) return
    started = true
    yield* agentHarness.run({
      prompt: request.prompt,
      sourceRepository: request.sourceRepository,
      sourceBranch: request.sourceBranch,
      publicationOptions: request.publicationOptions,
      repositoryAuthentication: request.repositoryAccessToken === undefined
        ? undefined
        : { token: Redacted.make(request.repositoryAccessToken) },
      modelAccess: request.openAIAccess === undefined
        ? undefined
        : {
            kind: "openai-subscription",
            accessToken: Redacted.make(request.openAIAccess.accessToken),
            expiresAt: request.openAIAccess.expiresAt,
            ...(request.openAIAccess.accountId === undefined
              ? {}
              : { accountId: request.openAIAccess.accountId })
          }
    }).pipe(
      Stream.runForEach((event) =>
        publish({ ...event, sequence: ++sequence })
      ),
      Effect.catch((cause) =>
        publish({
          _tag: "failed",
          sequence: ++sequence,
          error: {
            _tag: "AgentMicrovmError",
            operation: cause.operation,
            reason: errorReason(cause.cause)
          }
        })
      ),
      Effect.forkDetach({ startImmediately: true })
    )
  })

  return {
    start,
    events: () => watch(0, false),
    watch: ({ afterSequence }) => watch(afterSequence, true)
  }
}
