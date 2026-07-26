import { createOpencode as createOpencodeSdk } from "@opencode-ai/sdk/v2"
import { Effect, Schema } from "effect"

export class OpenCodeError extends Schema.TaggedErrorClass<OpenCodeError>()(
  "OpenCodeError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {}

export type OpenCodePart = {
  readonly type: string
  readonly text?: string
  readonly ignored?: boolean
}

export type OpenCodeAssistantMessage = {
  readonly error?: unknown
}

export type OpenCodeSessionCreateInput = {
  readonly directory: string
  readonly title: string
  readonly model: {
    readonly providerID: string
    readonly id: string
  }
}

export type OpenCodeSessionPromptInput = {
  readonly sessionID: string
  readonly directory: string
  readonly model: {
    readonly providerID: string
    readonly modelID: string
  }
  readonly parts: ReadonlyArray<{
    readonly type: "text"
    readonly text: string
  }>
}

type OpenCodeSdk = {
  readonly server: { readonly close: () => void }
  readonly client: {
    readonly session: {
      readonly create: (
        parameters: OpenCodeSessionCreateInput,
        options: { readonly throwOnError: true; readonly signal: AbortSignal }
      ) => Promise<{ readonly data: { readonly id: string } }>
      readonly prompt: (
        parameters: OpenCodeSessionPromptInput,
        options: { readonly throwOnError: true; readonly signal: AbortSignal }
      ) => Promise<{ readonly data: {
        readonly info: OpenCodeAssistantMessage
        readonly parts: ReadonlyArray<OpenCodePart>
      } }>
    }
  }
}

type CreateOpencode = (options: {
  readonly hostname: string
  readonly port: number
  readonly timeout: number
  readonly signal: AbortSignal
  readonly config: Record<string, unknown>
}) => Promise<OpenCodeSdk>

export type OpenCode = {
  readonly session: {
    readonly create: (
      input: OpenCodeSessionCreateInput
    ) => Effect.Effect<{ readonly id: string }, OpenCodeError>
    readonly prompt: (
      input: OpenCodeSessionPromptInput
    ) => Effect.Effect<{
      readonly info: OpenCodeAssistantMessage
      readonly parts: ReadonlyArray<OpenCodePart>
    }, OpenCodeError>
  }
}

// The generated SDK client type overflows TypeScript 5.9 when inferred through this adapter.
const createOpencode = createOpencodeSdk as unknown as CreateOpencode

export const makeOpenCode = (options: {
  readonly hostname: string
  readonly port: number
  readonly timeout: number
  readonly config: Record<string, unknown>
}) => Effect.acquireRelease(
  Effect.tryPromise({
    try: (signal) => createOpencode({ ...options, signal }),
    catch: (cause) => new OpenCodeError({ operation: "start", cause })
  }),
  (opencode) => Effect.try({
    try: () => opencode.server.close(),
    catch: (cause) => new OpenCodeError({ operation: "stop", cause })
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Unable to stop OpenCode", cause))
  ),
  { interruptible: true }
).pipe(
  Effect.map((opencode): OpenCode => ({
    session: {
      create: (input) => Effect.tryPromise({
        try: (signal) => opencode.client.session.create(
          input,
          { throwOnError: true, signal }
        ),
        catch: (cause) => new OpenCodeError({ operation: "create-session", cause })
      }).pipe(Effect.map((response) => response.data)),
      prompt: (input) => Effect.tryPromise({
        try: (signal) => opencode.client.session.prompt(
          input,
          { throwOnError: true, signal }
        ),
        catch: (cause) => new OpenCodeError({ operation: "prompt", cause })
      }).pipe(Effect.map((response) => response.data))
    }
  }))
)
