import { expect, test } from "bun:test"
import {
  BEDROCK_MODEL_ID,
  bedrockModel,
  bedrockOpencodeConfig
} from "../src/opencode/bedrock.ts"

test("restricts OpenCode to Claude Sonnet 4.6 on Bedrock", () => {
  const config = bedrockOpencodeConfig("eu-west-1")
  const model = "amazon-bedrock/global.anthropic.claude-sonnet-4-6"

  expect(BEDROCK_MODEL_ID).toBe("global.anthropic.claude-sonnet-4-6")
  expect(bedrockModel).toEqual({
    providerID: "amazon-bedrock",
    modelID: BEDROCK_MODEL_ID
  })
  expect(config.model).toBe(model)
  expect(config.small_model).toBe(model)
  expect(config.enabled_providers).toEqual(["amazon-bedrock"])
  expect((config.provider as {
    "amazon-bedrock": { options: unknown }
  })["amazon-bedrock"].options).toEqual({ region: "eu-west-1" })
})
