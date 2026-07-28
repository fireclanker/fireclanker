import { Effect } from "effect"
import { readConfig } from "../config.ts"
import { configureAwsSdk } from "./aws-sdk.ts"
import {
  readLocalOpenAISubscriptionCredential,
  storeOpenAISubscriptionCredential
} from "./openai-subscription.ts"
import { AlchemyServices } from "./services.ts"

export const configureOpenAISubscription = Effect.fn(
  "Infrastructure.configureOpenAISubscription"
)(function*() {
  const config = yield* readConfig
  const { clientConfig } = yield* configureAwsSdk(config)
  const credential = yield* readLocalOpenAISubscriptionCredential
  const parameterName = yield* storeOpenAISubscriptionCredential(
    config.name,
    credential,
    { clientConfig }
  )
  yield* Effect.logInfo(
    "Stored the OpenAI subscription credential for remote Fireclanker runs",
    { parameterName }
  )
}, Effect.provide(AlchemyServices), Effect.scoped)
