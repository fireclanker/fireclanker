import { NodeServices } from "@effect/platform-node"
import {
  AgentHarness,
  type AgentJob,
  type Publication,
  Repository
} from "@fireclanker/core"
import * as AWS from "alchemy/AWS"
import { Effect, Layer, Redacted } from "effect"
import dockerfile from "./Dockerfile?raw" with { type: "text" }
import type { AgentMicrovmError } from "./agent-microvm-response.ts"

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

export class AgentMicrovm extends AWS.Lambda.MicrovmImage<
  AgentMicrovm,
  {
    run: (request: {
      readonly prompt: string
      readonly sourceRepository: AgentJob.SourceRepository
      readonly sourceBranch?: AgentJob.SourceBranch
      readonly publicationOptions: ReadonlyArray<Publication.PublicationOption>
      readonly repositoryAccessToken?: string
    }) => Effect.Effect<{
      readonly result: string
      readonly baseSha: string
      readonly changes: Publication.ChangeSet
      readonly publication: Publication.PublicationDecision
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
      run: ({
        prompt,
        sourceRepository,
        sourceBranch,
        publicationOptions,
        repositoryAccessToken
      }) =>
        agentHarness.run({
          prompt,
          sourceRepository,
          sourceBranch,
          publicationOptions,
          repositoryAuthentication: repositoryAccessToken === undefined
            ? undefined
            : { token: Redacted.make(repositoryAccessToken) }
        }).pipe(
          Effect.mapError((cause): AgentMicrovmError => ({
            _tag: "AgentMicrovmError",
            operation: cause.operation,
            reason: errorReason(cause.cause)
          }))
        )
    }
  })
)

const GitHubRepositoryLive = Repository.GitHubRepository.pipe(
  Layer.provide(NodeServices.layer)
)

const OpenCodeAgentHarnessLive = AgentHarness.OpenCodeAgentHarness.pipe(
  Layer.provide(GitHubRepositoryLive)
)

export default AgentMicrovmLive.pipe(Layer.provide(OpenCodeAgentHarnessLive))
