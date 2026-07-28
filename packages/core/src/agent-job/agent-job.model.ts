import { DateTime, Effect, Schema } from "effect"
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

const sourceRepositoryPattern =
  /^(?![A-Za-z0-9-]*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/

export const SourceRepository = Schema.String.check(
  Schema.isPattern(
    sourceRepositoryPattern,
    { message: "Source Repository must use the GitHub owner/name format" }
  )
).pipe(Schema.brand("SourceRepository"))
export type SourceRepository = typeof SourceRepository.Type

const isValidSourceBranch = (branch: string): boolean =>
  branch.length > 0 &&
  branch.length <= 255 &&
  branch !== "@" &&
  !branch.startsWith("-") &&
  !branch.startsWith("/") &&
  !branch.endsWith("/") &&
  !branch.endsWith(".") &&
  !branch.includes("..") &&
  !branch.includes("@{") &&
  !branch.includes("//") &&
  !/[\u0000-\u0020\u007f~^:?*[\]\\]/.test(branch) &&
  branch.split("/").every((segment) =>
    !segment.startsWith(".") && !segment.endsWith(".lock")
  )

export const SourceBranch = Schema.String.check(
  Schema.makeFilter(
    (branch) => isValidSourceBranch(branch) ||
      "Source Branch must be a valid Git branch name",
    { title: "Source Branch" }
  )
).pipe(Schema.brand("SourceBranch"))
export type SourceBranch = typeof SourceBranch.Type

export const SourceRepositoryArgument = Schema.String.check(
  Schema.makeFilter((input) => {
    const separator = input.indexOf("@")
    const repository = separator < 0 ? input : input.slice(0, separator)
    const branch = separator < 0 ? undefined : input.slice(separator + 1)
    if (!sourceRepositoryPattern.test(repository)) {
      return "Source Repository must use the GitHub owner/name[@branch] format"
    }
    if (branch !== undefined && !isValidSourceBranch(branch)) {
      return "Source Branch must be a valid Git branch name"
    }
    return true
  }, { title: "Source Repository argument" })
).pipe(Schema.brand("SourceRepositoryArgument"))
export type SourceRepositoryArgument = typeof SourceRepositoryArgument.Type

export const parseSourceRepositoryArgument = (
  input: SourceRepositoryArgument
): {
  readonly sourceRepository: SourceRepository
  readonly sourceBranch?: SourceBranch
} => {
  const separator = input.indexOf("@")
  if (separator < 0) {
    return { sourceRepository: input as string as SourceRepository }
  }
  return {
    sourceRepository: input.slice(0, separator) as SourceRepository,
    sourceBranch: input.slice(separator + 1) as SourceBranch
  }
}

export const AgentJobResult = Schema.String.check(Schema.isMinLength(1))
export const FailureDescription = Schema.String.check(Schema.isMinLength(1))
export const AgentJobEventMessage = Schema.String.check(Schema.isMaxLength(8192))
export const AgentMicrovmId = Schema.String.check(Schema.isMinLength(1))
export const AgentMicrovmEndpoint = Schema.String.check(Schema.isMinLength(1))

const fields = {
  id: AgentJobId,
  prompt: AgentPrompt,
  sourceRepository: Schema.optionalKey(SourceRepository),
  sourceBranch: Schema.optionalKey(SourceBranch),
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
  startedAt: Schema.DateTimeUtcFromString,
  microvmId: Schema.optionalKey(AgentMicrovmId),
  microvmEndpoint: Schema.optionalKey(AgentMicrovmEndpoint),
  microvmEventBaseSequence: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(-1))
  )
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
  sourceRepository: SourceRepository,
  sourceBranch?: SourceBranch
) {
  const id = yield* Effect.sync(() => crypto.randomUUID() as AgentJobId)
  const createdAt = yield* DateTime.now
  const job = new QueuedAgentJob({
    id,
    prompt,
    sourceRepository,
    ...(sourceBranch === undefined ? {} : { sourceBranch }),
    status: "queued",
    createdAt
  })
  const createdAtIso = DateTime.formatIso(createdAt)

  return { job, createdAtIso } as const
})
