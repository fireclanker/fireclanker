import * as AWS from "alchemy/AWS"
import { Effect } from "effect"
import { BEDROCK_MODEL_ID } from "../opencode/bedrock.ts"
import { runOpencode } from "../opencode/run.ts"
import dockerfile from "./Dockerfile?raw" with { type: "text" }

type AgentMicrovmError = {
  readonly _tag: "AgentMicrovmError"
  readonly operation: string
}

export class AgentMicrovm extends AWS.Lambda.MicrovmImage<
  AgentMicrovm,
  {
    run: (prompt: string) => Effect.Effect<{
      readonly result: string
      readonly logs: ReadonlyArray<string>
    }, AgentMicrovmError>
  }
>()("AgentMicrovm") {}

const AgentMicrovmBuildRole = AWS.IAM.Role("AgentMicrovmBuildRole")

export const AgentMicrovmExecutionRole = AWS.IAM.Role("AgentMicrovmExecutionRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: ["sts:AssumeRole"]
    }]
  },
  inlinePolicies: {
    BedrockSonnet46: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ],
        Resource: [
          `arn:aws:bedrock:*:*:inference-profile/${BEDROCK_MODEL_ID}`,
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6"
        ]
      }]
    }
  }
})

export default AgentMicrovm.make(
  AgentMicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      dockerfile,
      buildRole,
      runtime: "node" as const,
      env: {
        FIRECLANKER_AGENT_SOURCE_HASH:
          process.env.FIRECLANKER_AGENT_SOURCE_HASH ?? "development"
      },
      resources: [{ minimumMemoryInMiB: 1024 }],
      cpuConfigurations: [{ architecture: "ARM_64" as const }]
    }))
  ),
  Effect.gen(function*() {
    return {
      run: (prompt: string) => runOpencode(prompt).pipe(
        Effect.mapError((cause): AgentMicrovmError => ({
          _tag: "AgentMicrovmError",
          operation: cause.operation
        })),
        Effect.tap(() => Effect.logInfo("OpenCode execution completed")),
        Effect.map((result) => ({
          result,
          logs: ["[microvm] OpenCode completed with Claude Sonnet 4.6 on Bedrock"]
        }))
      )
    }
  })
)
