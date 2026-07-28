import { expect, test } from "bun:test"
import {
  AgentCompletion,
  CreatePullRequestOption,
  offeredPublicationOptions,
  PublicationTargetSelection,
  UpdatePullRequestOption
} from "../src/publication/index.ts"
import { structuredOutputSchema } from "../src/agent-harness/layer/opencode/run.ts"

const create = new CreatePullRequestOption({
  id: "create-pull-request",
  kind: "create-pull-request",
  baseBranch: "main",
  branch: "fireclanker/new",
  expectedHeadSha: "1111111111111111111111111111111111111111"
})

const update = new UpdatePullRequestOption({
  id: "update-pull-request:7:2222222222222222222222222222222222222222",
  kind: "update-pull-request",
  pullRequestNumber: 7,
  title: "Existing work",
  branch: "fireclanker/existing",
  expectedHeadSha: "2222222222222222222222222222222222222222"
})

test("offers an existing branch only when the task explicitly references it", () => {
  expect(offeredPublicationOptions("Implement a new feature", [create, update]))
    .toEqual([create])
  expect(offeredPublicationOptions("Continue PR #7", [create, update]))
    .toEqual([create, update])
  expect(offeredPublicationOptions(
    "Continue https://github.com/acme/repo/pull/7",
    [create, update]
  )).toEqual([create, update])
  expect(offeredPublicationOptions("Continue fireclanker/existing", [create, update]))
    .toEqual([create, update])
  expect(offeredPublicationOptions(
    "Continue the selected source",
    [create, update],
    "fireclanker/existing"
  )).toEqual([create, update])
})

test("provides OpenCode with a top-level object schema for structured decisions", () => {
  const selection = structuredOutputSchema(PublicationTargetSelection)
  const completion = structuredOutputSchema(AgentCompletion)

  expect(selection.type).toBe("object")
  expect(completion.type).toBe("object")
  expect(completion).toHaveProperty("$defs")
  expect(completion).not.toHaveProperty("dialect")
  expect(completion).not.toHaveProperty("schema")
})
