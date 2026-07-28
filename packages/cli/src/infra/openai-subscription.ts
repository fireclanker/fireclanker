import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
  type GetParameterCommandOutput,
  type PutParameterCommandOutput,
  type SSMClientConfig
} from "@aws-sdk/client-ssm"
import { Effect, Redacted, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

type OpenAISubscriptionSsmCommand = GetParameterCommand | PutParameterCommand
type OpenAISubscriptionSsmOutput =
  | GetParameterCommandOutput
  | PutParameterCommandOutput

export interface OpenAISubscriptionSsmClient {
  readonly send: (
    command: OpenAISubscriptionSsmCommand
  ) => Promise<OpenAISubscriptionSsmOutput>
  readonly destroy?: () => void
}

export interface OpenAISubscriptionSsmOptions {
  readonly client?: OpenAISubscriptionSsmClient
  readonly clientConfig?: SSMClientConfig
}

export interface RefreshOpenAISubscriptionOptions
  extends OpenAISubscriptionSsmOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

const NonEmptySecret = Schema.String.check(Schema.isNonEmpty())
const FutureTimestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
)

export const OpenAISubscriptionCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  refresh: NonEmptySecret,
  access: NonEmptySecret,
  expires: FutureTimestamp,
  accountId: Schema.optionalKey(NonEmptySecret)
})
export type OpenAISubscriptionCredential =
  typeof OpenAISubscriptionCredential.Type

const OpenAISubscriptionEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  credential: OpenAISubscriptionCredential
})

const OpenAITokenResponse = Schema.Struct({
  access_token: NonEmptySecret,
  refresh_token: Schema.optionalKey(NonEmptySecret),
  expires_in: Schema.optionalKey(Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ))
})

// OpenCode 1.18.3's built-in ChatGPT OAuth client. Keep this synchronized with
// packages/opencode/src/plugin/openai/codex.ts when the pinned runtime changes.
const OPENCODE_OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"

export const openAISubscriptionParameterName = (
  deploymentName: string
): string => `/fireclanker/${deploymentName}/openai-subscription`

const makeClient = (
  options: OpenAISubscriptionSsmOptions
): {
  readonly client: OpenAISubscriptionSsmClient
  readonly owned: boolean
} => ({
  client: options.client ?? (options.clientConfig === undefined
    ? new SSMClient()
    : new SSMClient(options.clientConfig)),
  owned: options.client === undefined
})

export const readLocalOpenAISubscriptionCredential = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataHome = yield* Effect.sync(() => process.env.XDG_DATA_HOME)
  const home = yield* Effect.sync(() => process.env.HOME)
  const authPath = dataHome
    ? path.join(dataHome, "opencode", "auth.json")
    : home
      ? path.join(home, ".local", "share", "opencode", "auth.json")
      : undefined
  if (authPath === undefined) {
    return yield* Effect.fail(new Error(
      "Neither XDG_DATA_HOME nor HOME is set; OpenCode credentials cannot be located"
    ))
  }
  const contents = yield* fs.readFileString(authPath).pipe(
    Effect.mapError((cause) => new Error(
      `Unable to read OpenCode credentials at ${authPath}. Run 'opencode providers login --provider openai' first.`,
      { cause }
    ))
  )
  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (cause) => new Error(`Invalid OpenCode credentials at ${authPath}`, {
      cause
    })
  })
  const openai = typeof parsed === "object" && parsed !== null &&
      "openai" in parsed
    ? parsed.openai
    : undefined
  return yield* Schema.decodeUnknownEffect(OpenAISubscriptionCredential)(
    openai
  ).pipe(
    Effect.mapError(() => new Error(
      `No ChatGPT subscription credential was found at ${authPath}. Run 'opencode providers login --provider openai' and choose ChatGPT Pro/Plus.`
    ))
  )
})

export const storeOpenAISubscriptionCredential = Effect.fn(
  "OpenAI.storeSubscriptionCredential"
)(function*(
  deploymentName: string,
  credential: OpenAISubscriptionCredential,
  options: OpenAISubscriptionSsmOptions = {}
) {
  const decoded = yield* Schema.decodeUnknownEffect(
    OpenAISubscriptionCredential
  )(credential).pipe(
    Effect.mapError(() => new Error("OpenAI subscription credential is invalid"))
  )
  const { client, owned } = makeClient(options)
  return yield* Effect.tryPromise({
    try: () => client.send(new PutParameterCommand({
      Name: openAISubscriptionParameterName(deploymentName),
      Description: "Fireclanker OpenAI ChatGPT subscription credential",
      Type: "SecureString",
      Tier: "Standard",
      Value: JSON.stringify({
        version: 1,
        credential: decoded
      }),
      Overwrite: true
    })),
    catch: (cause) => new Error(
      "Unable to store OpenAI subscription credential in Parameter Store",
      { cause }
    )
  }).pipe(
    Effect.as(openAISubscriptionParameterName(deploymentName)),
    Effect.ensuring(owned
      ? Effect.sync(() => client.destroy?.())
      : Effect.void)
  )
})

export const readOpenAISubscriptionCredential = Effect.fn(
  "OpenAI.readSubscriptionCredential"
)(function*(
  deploymentName: string,
  options: OpenAISubscriptionSsmOptions = {}
) {
  const { client, owned } = makeClient(options)
  return yield* Effect.tryPromise({
    try: () => client.send(new GetParameterCommand({
      Name: openAISubscriptionParameterName(deploymentName),
      WithDecryption: true
    })),
    catch: (cause) => cause
  }).pipe(
    Effect.catchIf(
      (cause) => cause instanceof ParameterNotFound,
      () => Effect.succeed(undefined)
    ),
    Effect.mapError((cause) => new Error(
      "Unable to read OpenAI subscription credential from Parameter Store",
      { cause }
    )),
    Effect.flatMap((output) => {
      if (output === undefined) return Effect.succeed(undefined)
      const parameter = output as GetParameterCommandOutput
      if (
        parameter.Parameter?.Type !== "SecureString" ||
        parameter.Parameter.Value === undefined
      ) {
        return Effect.fail(new Error(
          "OpenAI subscription credential parameter is invalid"
        ))
      }
      return Schema.decodeUnknownEffect(
        Schema.fromJsonString(OpenAISubscriptionEnvelope)
      )(parameter.Parameter.Value).pipe(
        Effect.map((envelope) => envelope.credential),
        Effect.mapError(() => new Error(
          "OpenAI subscription credential parameter is invalid"
        ))
      )
    }),
    Effect.ensuring(owned
      ? Effect.sync(() => client.destroy?.())
      : Effect.void)
  )
})

export const refreshOpenAISubscriptionAccess = Effect.fn(
  "OpenAI.refreshSubscriptionAccess"
)(function*(
  deploymentName: string,
  options: RefreshOpenAISubscriptionOptions = {}
) {
  const credential = yield* readOpenAISubscriptionCredential(
    deploymentName,
    options
  )
  if (credential === undefined) return undefined

  const fetch = options.fetch ?? globalThis.fetch
  const response = yield* Effect.tryPromise({
    try: () => fetch(OPENAI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: OPENCODE_OPENAI_CLIENT_ID
      }).toString()
    }),
    catch: (cause) => new Error("Unable to refresh OpenAI subscription access", {
      cause
    })
  })
  if (!response.ok) {
    return yield* Effect.fail(new Error(
      `Unable to refresh OpenAI subscription access: HTTP ${response.status}`
    ))
  }
  const tokens = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new Error(
      "OpenAI subscription refresh returned invalid JSON",
      { cause }
    )
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OpenAITokenResponse)),
    Effect.mapError(() => new Error(
      "OpenAI subscription refresh returned an invalid token response"
    ))
  )
  const now = options.now?.() ?? Date.now()
  const expiresInSeconds = tokens.expires_in ?? 3600
  const refreshed: OpenAISubscriptionCredential = {
    type: "oauth",
    refresh: tokens.refresh_token ?? credential.refresh,
    access: tokens.access_token,
    expires: now + expiresInSeconds * 1000,
    ...(credential.accountId === undefined
      ? {}
      : { accountId: credential.accountId })
  }
  yield* storeOpenAISubscriptionCredential(
    deploymentName,
    refreshed,
    options
  )
  return {
    accessToken: Redacted.make(refreshed.access),
    expiresAt: refreshed.expires,
    accountId: refreshed.accountId
  }
})
