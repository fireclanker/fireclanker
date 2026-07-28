const providerId = "openai"

export const OPENAI_MODEL_ID = "gpt-5.6-sol"

export const openAIModel = {
  providerID: providerId,
  modelID: OPENAI_MODEL_ID
} as const

export const openAIOpencodeConfig = (): Record<string, unknown> => ({
  autoupdate: false,
  share: "disabled" as const,
  model: `${providerId}/${OPENAI_MODEL_ID}`,
  small_model: `${providerId}/${OPENAI_MODEL_ID}`,
  enabled_providers: [providerId]
})
