import { DateTime, Effect, Schema, SchemaGetter } from "effect"
import { Model } from "effect/unstable/schema"

/**
  * @since
  * @category id
  */
export const AgentJobId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("AgentJobId")
)
export type AgentJobId = typeof AgentJobId.Type

export const AgentPrompt = Schema.String.check(
  Schema.isPattern(/\S/, {
    message: "Agent prompt must contain a non-whitespace character"
  })
).pipe(Schema.brand("AgentPrompt"))
export type AgentPrompt = typeof AgentPrompt.Type

/**
  * The canonical `owner/name` form of a Target Repository.
  *
  * @since
  * @category model
  */
export const TargetRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/, {
    message: "Target Repository must be an owner/name pair"
  })
).pipe(Schema.brand("TargetRepository"))
export type TargetRepository = typeof TargetRepository.Type

const gitHubHttpsPrefix = "https://github.com/"

const normalizeTargetRepository = (input: string): string => {
  const withoutPrefix = input.startsWith(gitHubHttpsPrefix)
    ? input.slice(gitHubHttpsPrefix.length)
    : input
  const withoutTrailingSlashes = withoutPrefix.replace(/\/+$/, "")
  return withoutTrailingSlashes.endsWith(".git")
    ? withoutTrailingSlashes.slice(0, -".git".length)
    : withoutTrailingSlashes
}

/**
  * Decodes user-supplied Target Repository input — an `owner/name` pair or a
  * full `https://github.com/owner/name` URL — into the canonical `owner/name`
  * binding.
  *
  * @since
  * @category model
  */
export const TargetRepositoryFromString = Schema.String.pipe(
  Schema.decodeTo(TargetRepository, {
    decode: SchemaGetter.transform(normalizeTargetRepository),
    encode: SchemaGetter.transform((targetRepository: string) => targetRepository)
  })
)

export const AgentJobResult = Schema.String.check(Schema.isMinLength(1))
export const FailureDescription = Schema.String.check(Schema.isMinLength(1))
export const AgentJobEventMessage = Schema.String.check(Schema.isMaxLength(8192))

const fields = {
  id: AgentJobId,
  prompt: AgentPrompt,
  targetRepository: Schema.optional(TargetRepository),
  createdAt: Schema.DateTimeUtcFromString
} as const

/**
  * @since
  * @category model
  */
export class QueuedAgentJob extends Model.Class<QueuedAgentJob>("QueuedAgentJob")({
  ...fields,
  status: Schema.Literal("queued")
}) { }

/**
  * @since
  * @category model
  */
export class RunningAgentJob extends Model.Class<RunningAgentJob>("RunningAgentJob")({
  ...fields,
  status: Schema.Literal("running"),
  startedAt: Schema.DateTimeUtcFromString
}) { }

/**
  * @since
  * @category model
  */
export class SucceededAgentJob extends Model.Class<SucceededAgentJob>("SucceededAgentJob")({
  ...fields,
  status: Schema.Literal("succeeded"),
  startedAt: Schema.DateTimeUtcFromString,
  completedAt: Schema.DateTimeUtcFromString,
  result: AgentJobResult
}) { }

/**
  * @since
  * @category model
  */
export class FailedAgentJob extends Model.Class<FailedAgentJob>("FailedAgentJob")({
  ...fields,
  status: Schema.Literal("failed"),
  startedAt: Schema.DateTimeUtcFromString,
  completedAt: Schema.DateTimeUtcFromString,
  failure: FailureDescription
}) { }

/**
  * @since
  * @category model
  */
export const AgentJob = Schema.Union([
  QueuedAgentJob,
  RunningAgentJob,
  SucceededAgentJob,
  FailedAgentJob
])
export type AgentJob = typeof AgentJob.Type

/**
  * @since
  * @category model
  */
export class AgentJobEvent extends Model.Class<AgentJobEvent>("AgentJobEvent")({
  jobId: AgentJobId,
  sequence: Schema.Number,
  message: AgentJobEventMessage,
  createdAt: Schema.DateTimeUtcFromString
}) { }

/**
  * @since
  * @category model method
  */
export const make = Effect.fn("AgentJob.make")(function*(
  prompt: AgentPrompt,
  targetRepository?: TargetRepository
) {
  const id = yield* Effect.sync(() => crypto.randomUUID() as AgentJobId)
  const createdAt = yield* DateTime.now
  const job = new QueuedAgentJob({ id, prompt, targetRepository, status: "queued", createdAt })
  const createdAtIso = DateTime.formatIso(createdAt)

  return { job, createdAtIso } as const
})
