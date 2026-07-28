import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { Effect, JsonSchema, Schema } from "effect"
import type {
  SourceBranch,
  SourceRepository
} from "../../../agent-job/agent-job.model.ts"
import {
  AgentCompletion,
  type PublicationOption,
  PublicationTargetSelection
} from "../../../publication/publication.model.ts"
import {
  Repository,
  type RepositoryCheckoutRequest
} from "../../../repository/service/repository.service.ts"
import { bedrockModel, bedrockOpencodeConfig } from "./bedrock.ts"
import { makeOpenCode, OpenCodeError } from "./effect-sdk.ts"

export const structuredOutputSchema = <A>(
  schema: Schema.Codec<A, unknown, never, never>
): Record<string, unknown> => {
  const document = JsonSchema.resolveTopLevel$ref(
    Schema.toJsonSchemaDocument(schema)
  )
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

const targetSelectionInstructions = (
  prompt: string,
  options: ReadonlyArray<PublicationOption>
): string => [
  "Select the repository state on which this coding task should be performed.",
  "Do not modify files yet. Only select a target.",
  "Choose an existing pull request only when it is clearly the same work;",
  "otherwise choose the create-pull-request option.",
  "Task:",
  prompt,
  "Available targets:",
  JSON.stringify(options)
].join("\n")

const publicationInstructions = (
  option: PublicationOption | undefined
): string => [
  "",
  "Publication decision:",
  "After completing the coding task, decide whether the changes should be published.",
  "Choose the selected publication option ID below, or choose do-not-publish",
  "when there are no useful changes, the work is incomplete, or publishing would be unsafe.",
  "Selected publication target:",
  option === undefined ? "No publication target is available." : JSON.stringify(option)
].join("\n")

export const runOpencode = Effect.fn("OpenCode.run")(
  function*({
    prompt,
    sourceRepository,
    sourceBranch,
    publicationOptions,
    repositoryAuthentication
  }: {
    readonly prompt: string
    readonly sourceRepository: SourceRepository
    readonly sourceBranch?: SourceBranch
    readonly publicationOptions: ReadonlyArray<PublicationOption>
    readonly repositoryAuthentication?: RepositoryCheckoutRequest["authentication"]
  }, emit: (message: string) => Effect.Effect<unknown>) {
    const repository = yield* Repository
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "fireclanker-")),
        catch: (cause) => new OpenCodeError({ operation: "create-temporary-directory", cause })
      }),
      (root) => Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: (cause) => new OpenCodeError({ operation: "remove-temporary-directory", cause })
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning(
          "Unable to remove temporary OpenCode directory",
          cause
        ))
      )
    )
    const workspace = join(root, "workspace")
    const checkout = yield* repository.checkout({
      sourceRepository,
      sourceBranch,
      destination: workspace,
      candidateBaseShas: publicationOptions.map((option) => option.expectedHeadSha),
      authentication: repositoryAuthentication
    }).pipe(
      Effect.mapError((error) => new OpenCodeError({
        operation: "clone-repository",
        cause: error.cause
      }))
    )
    yield* emit("[microvm] Source Repository checkout completed")
    repositoryAuthentication = undefined
    const credentials = yield* Effect.tryPromise({
      try: () => fromNodeProviderChain()(),
      catch: (cause) => new OpenCodeError({ operation: "resolve-aws-credentials", cause })
    })
    const previousCredentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
    yield* Effect.sync(() => {
      process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId
      process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey
      if (credentials.sessionToken) process.env.AWS_SESSION_TOKEN = credentials.sessionToken
      else delete process.env.AWS_SESSION_TOKEN
    })
    const opencode = yield* makeOpenCode({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 30_000,
      config: bedrockOpencodeConfig(
        process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        restoreEnvironment("AWS_ACCESS_KEY_ID", previousCredentials.accessKeyId)
        restoreEnvironment("AWS_SECRET_ACCESS_KEY", previousCredentials.secretAccessKey)
        restoreEnvironment("AWS_SESSION_TOKEN", previousCredentials.sessionToken)
      }))
    )

    const session = yield* opencode.session.create({
      directory: workspace,
      title: "Fireclanker run",
      model: { providerID: bedrockModel.providerID, id: bedrockModel.modelID }
    })
    let selectedOption: PublicationOption | undefined
    let selectedBaseSha = checkout.baseSha
    if (publicationOptions.length > 0) {
      const selectionResponse = yield* opencode.session.prompt({
        sessionID: session.id,
        directory: workspace,
        model: bedrockModel,
        format: {
          type: "json_schema",
          schema: structuredOutputSchema(PublicationTargetSelection),
          retryCount: 2
        },
        parts: [{
          type: "text",
          text: targetSelectionInstructions(prompt, publicationOptions)
        }]
      })
      if (selectionResponse.info.error) {
        return yield* Effect.fail(new OpenCodeError({
          operation: "select-publication-target",
          cause: selectionResponse.info.error
        }))
      }
      const selection = yield* Schema.decodeUnknownEffect(PublicationTargetSelection)(
        selectionResponse.info.structured
      ).pipe(
        Effect.mapError((cause) => new OpenCodeError({
          operation: "read-publication-target",
          cause
        }))
      )
      selectedOption = publicationOptions.find((option) =>
        option.id === selection.optionId
      )
      if (selectedOption === undefined) {
        return yield* Effect.fail(new OpenCodeError({
          operation: "authorize-publication-target",
          cause: new Error("Agent selected an unavailable publication target")
        }))
      }
      selectedBaseSha = selectedOption.expectedHeadSha
      yield* repository.reset({
        destination: workspace,
        baseSha: selectedBaseSha
      }).pipe(
        Effect.mapError((error) => new OpenCodeError({
          operation: "prepare-publication-target",
          cause: error.cause
        }))
      )
    }
    const response = yield* opencode.session.prompt({
      sessionID: session.id,
      directory: workspace,
      model: bedrockModel,
      format: {
        type: "json_schema",
        schema: structuredOutputSchema(AgentCompletion),
        retryCount: 2
      },
      parts: [{
        type: "text",
        text: `${prompt}${publicationInstructions(selectedOption)}`
      }]
    })

    if (response.info.error) {
      return yield* Effect.fail(new OpenCodeError({
        operation: "prompt-response",
        cause: response.info.error
      }))
    }
    const completion = yield* Schema.decodeUnknownEffect(AgentCompletion)(
      response.info.structured
    ).pipe(
      Effect.mapError((cause) => new OpenCodeError({
        operation: "read-structured-response",
        cause
      }))
    )
    if (
      completion.publication.kind === "publish" &&
      completion.publication.optionId !== selectedOption?.id
    ) {
      return yield* Effect.fail(new OpenCodeError({
        operation: "authorize-publication-decision",
        cause: new Error("Agent changed to an unavailable publication target")
      }))
    }
    yield* emit("[microvm] OpenCode completed with Claude Sonnet 4.6 on Bedrock")
    yield* emit(`[microvm] Agent selected ${completion.publication.kind}`)
    const changes = completion.publication.kind === "publish"
      ? yield* repository.changes({
        destination: workspace,
        baseSha: selectedBaseSha
      }).pipe(
        Effect.mapError((error) => new OpenCodeError({
          operation: "capture-repository-changes",
          cause: error.cause
        }))
      )
      : []
    return {
      result: completion.response,
      baseSha: selectedBaseSha,
      changes,
      publication: completion.publication
    }
  },
  Effect.scoped
)

const restoreEnvironment = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
