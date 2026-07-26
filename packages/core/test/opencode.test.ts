import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { SourceRepository } from "../src/agent-job/agent-job.model.ts"
import {
  AgentHarness,
  OpenCodeAgentHarness
} from "../src/agent-harness/index.ts"
import { GitHubRepository } from "../src/repository/index.ts"

const OpenCodeAgentHarnessLive = OpenCodeAgentHarness.pipe(
  Layer.provide(GitHubRepository.pipe(Layer.provide(NodeServices.layer)))
)

test.skipIf(Bun.which("opencode") === null || process.env.FIRECLANKER_OPENCODE_INTEGRATION !== "1")(
  "runs OpenCode with Claude Sonnet 4.6 on Bedrock",
  async () => {
    const previousCredentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
    const response = await Effect.runPromise(Effect.gen(function*() {
      const agentHarness = yield* AgentHarness
      return yield* agentHarness.run({
        prompt: "Reply with exactly: hello from fireclanker",
        sourceRepository: Schema.decodeUnknownSync(SourceRepository)(
          "octocat/Hello-World"
        )
      })
    }).pipe(Effect.provide(OpenCodeAgentHarnessLive)))
    expect(response.result).toContain("hello from fireclanker")
    expect({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }).toEqual(previousCredentials)
  },
  190_000
)
