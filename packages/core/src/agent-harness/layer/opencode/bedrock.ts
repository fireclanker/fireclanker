const providerId = "amazon-bedrock"

export const BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-4-6"

export const bedrockModel = {
  providerID: providerId,
  modelID: BEDROCK_MODEL_ID
} as const

export const bedrockOpencodeConfig = (region: string): Record<string, unknown> => ({
  autoupdate: false,
  share: "disabled" as const,
  model: `${providerId}/${BEDROCK_MODEL_ID}`,
  small_model: `${providerId}/${BEDROCK_MODEL_ID}`,
  enabled_providers: [providerId],
  provider: {
    [providerId]: {
      options: { region }
    }
  }
})
