import { expect, test } from "bun:test"
import {
  OPENAI_MODEL_ID
} from "../src/agent-harness/layer/opencode-agent-harness.service.ts"
import {
  openAIModel,
  openAIOpencodeConfig
} from "../src/agent-harness/layer/opencode/openai.ts"

test("restricts subscription-backed OpenCode to GPT-5.6 Sol", () => {
  const config = openAIOpencodeConfig()
  const model = "openai/gpt-5.6-sol"

  expect(OPENAI_MODEL_ID).toBe("gpt-5.6-sol")
  expect(openAIModel).toEqual({
    providerID: "openai",
    modelID: OPENAI_MODEL_ID
  })
  expect(config.model).toBe(model)
  expect(config.small_model).toBe(model)
  expect(config.enabled_providers).toEqual(["openai"])
})
