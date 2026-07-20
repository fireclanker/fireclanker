import { expect, test } from "bun:test"
import { Effect } from "effect"
import { runOpencodeWithMock } from "../src/opencode/run.ts"

test.skipIf(Bun.which("opencode") === null || process.env.FIRECLANKER_OPENCODE_INTEGRATION !== "1")(
  "runs the real OpenCode server against the mock LLM",
  async () => {
    expect(await Effect.runPromise(runOpencodeWithMock("hello from fireclanker"))).toBe(
      "mock response: hello from fireclanker"
    )
  },
  190_000
)
