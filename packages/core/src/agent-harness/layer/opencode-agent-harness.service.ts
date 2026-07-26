import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
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
    const run: IAgentHarness["run"] = Effect.fn("OpenCodeAgentHarness.run")(
      (request) => runOpencode(request).pipe(
        Effect.provide(NodeServices.layer),
        Effect.mapError((error) => new AgentHarnessError({
          operation: error.operation,
          cause: error.cause
        })),
        Effect.tap(() => Effect.logInfo("OpenCode execution completed")),
        Effect.map((result) => ({
          result,
          logs: [
            "[microvm] public Source Repository checkout completed",
            "[microvm] OpenCode completed with Claude Sonnet 4.6 on Bedrock"
          ]
        }))
      )
    )

    return AgentHarness.of({ run })
  })
)
