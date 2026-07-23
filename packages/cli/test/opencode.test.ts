import { expect, test } from "bun:test"
import { Effect } from "effect"
import { runOpencode } from "../src/opencode/run.ts"

test.skipIf(Bun.which("opencode") === null || process.env.FIRECLANKER_OPENCODE_INTEGRATION !== "1")(
  "runs OpenCode with Claude Sonnet 4.6 on Bedrock",
  async () => {
    const previousCredentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
    expect(await Effect.runPromise(runOpencode(
      "Reply with exactly: hello from fireclanker"
    ))).toContain("hello from fireclanker")
    expect({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }).toEqual(previousCredentials)
  },
  190_000
)
