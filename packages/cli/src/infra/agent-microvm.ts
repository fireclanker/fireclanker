import { AgentHarness, type AgentJob } from "@fireclanker/core"
import * as AWS from "alchemy/AWS"
import { Effect, Layer } from "effect"
import dockerfile from "./Dockerfile?raw" with { type: "text" }

type AgentMicrovmError = {
  readonly _tag: "AgentMicrovmError"
  readonly operation: string
}

export class AgentMicrovm extends AWS.Lambda.MicrovmImage<
  AgentMicrovm,
  {
    run: (request: {
      readonly prompt: string
      readonly sourceRepository: AgentJob.SourceRepository
    }) => Effect.Effect<{
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
          `arn:aws:bedrock:*:*:inference-profile/${AgentHarness.BEDROCK_MODEL_ID}`,
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6"
        ]
      }]
    }
  }
})

export const AgentMicrovmLive = AgentMicrovm.make(
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
    const agentHarness = yield* AgentHarness.AgentHarness

    return {
      run: ({ prompt, sourceRepository }: AgentHarness.AgentHarnessRunRequest) =>
        agentHarness.run({ prompt, sourceRepository }).pipe(
          Effect.mapError((cause): AgentMicrovmError => ({
            _tag: "AgentMicrovmError",
            operation: cause.operation
          }))
        )
    }
  })
)

export default AgentMicrovmLive.pipe(Layer.provide(AgentHarness.OpenCodeAgentHarness))
