import { Effect, Layer, Queue, Stream } from "effect"
import { Repository } from "../../repository/service/repository.service.ts"
import { AgentHarnessError } from "../error.ts"
import {
  AgentHarness,
  type IAgentHarness
} from "../service/agent-harness.service.ts"
import { runOpencode } from "./opencode/run.ts"

export { BEDROCK_MODEL_ID } from "./opencode/bedrock.ts"
export { OPENAI_MODEL_ID } from "./opencode/openai.ts"

/**
  * @since
  * @category layer
  */
export const OpenCodeAgentHarness = Layer.effect(
  AgentHarness,
  Effect.gen(function*() {
    const repository = yield* Repository
    const run: IAgentHarness["run"] = (request) =>
      Stream.callback((queue) =>
        runOpencode(
          request,
          (message) => Queue.offer(queue, { _tag: "log", message })
        ).pipe(
          Effect.provideService(Repository, repository),
          Effect.mapError((error) => new AgentHarnessError({
            operation: error.operation,
            cause: error.cause
          })),
          Effect.tap(() => Effect.logInfo("OpenCode execution completed")),
          Effect.flatMap((result) =>
            Queue.offer(queue, { _tag: "completed", result })
          ),
          Effect.andThen(Queue.end(queue)),
          Effect.catch((error) => Queue.fail(queue, error))
        )
      )

    return AgentHarness.of({ run })
  })
)
