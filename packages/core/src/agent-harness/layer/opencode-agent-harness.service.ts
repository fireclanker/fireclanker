import { Effect, Layer } from "effect"
import { Repository } from "../../repository/service/repository.service.ts"
import { AgentHarnessError } from "../error.ts"
import {
  AgentHarness,
  type IAgentHarness
} from "../service/agent-harness.service.ts"
import { runOpencode } from "./opencode/run.ts"

export { BEDROCK_MODEL_ID } from "./opencode/bedrock.ts"

/**
  * @since
  * @category layer
  */
export const OpenCodeAgentHarness = Layer.effect(
  AgentHarness,
  Effect.gen(function*() {
    const repository = yield* Repository
    const run: IAgentHarness["run"] = Effect.fn("OpenCodeAgentHarness.run")(
      (request) => runOpencode(request).pipe(
        Effect.provideService(Repository, repository),
        Effect.mapError((error) => new AgentHarnessError({
          operation: error.operation,
          cause: error.cause
        })),
        Effect.tap(() => Effect.logInfo("OpenCode execution completed")),
        Effect.map((result) => ({
          ...result,
          logs: [
            "[microvm] Source Repository checkout completed",
            "[microvm] OpenCode completed with Claude Sonnet 4.6 on Bedrock",
            `[microvm] Agent selected ${result.publication.kind}`
          ]
        }))
      )
    )

    return AgentHarness.of({ run })
  })
)
