import { AgentJob } from "@fireclanker/core"
import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { runOpencode } from "../src/opencode/run.ts"

test.skipIf(Bun.which("opencode") === null || process.env.FIRECLANKER_OPENCODE_INTEGRATION !== "1")(
  "runs OpenCode with Claude Sonnet 4.6 on Bedrock",
  async () => {
    const previousCredentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
    expect(await Effect.runPromise(runOpencode({
      prompt: "Reply with exactly: hello from fireclanker",
      sourceRepository: Schema.decodeUnknownSync(AgentJob.SourceRepository)(
        "octocat/Hello-World"
      )
    }).pipe(Effect.provide(NodeServices.layer)))).toContain("hello from fireclanker")
    expect({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }).toEqual(previousCredentials)
  },
  190_000
)
