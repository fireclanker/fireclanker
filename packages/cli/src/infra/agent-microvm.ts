import { NodeServices } from "@effect/platform-node"
import {
  AgentHarness,
  Repository
} from "@fireclanker/core"
import * as AWS from "alchemy/AWS"
import { Effect, Layer } from "effect"
import dockerfile from "./Dockerfile?raw" with { type: "text" }
import { makeAgentMicrovmCoordinator } from "./agent-microvm-coordinator.ts"
import { AgentMicrovm } from "./agent-microvm-rpc.ts"

export { AgentMicrovm } from "./agent-microvm-rpc.ts"

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
    return makeAgentMicrovmCoordinator(agentHarness)
  })
)

const GitHubRepositoryLive = Repository.GitHubRepository.pipe(
  Layer.provide(NodeServices.layer)
)

const OpenCodeAgentHarnessLive = AgentHarness.OpenCodeAgentHarness.pipe(
  Layer.provide(GitHubRepositoryLive)
)

export default AgentMicrovmLive.pipe(Layer.provide(OpenCodeAgentHarnessLive))
