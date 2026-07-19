import { DateTime, Effect, Schema } from "effect"
import { Model } from "effect/unstable/schema"

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

export class AgentJob extends Model.Class<AgentJob>("AgentJob")({
  id: AgentJobId,
  prompt: AgentPrompt,
  status: Schema.Literal("queued"),
  createdAt: Schema.DateTimeUtc
}) {}

export const make = Effect.fn("AgentJob.make")(function*(prompt: AgentPrompt) {
  const id = yield* Effect.sync(() => crypto.randomUUID() as AgentJobId)
  const createdAt = yield* DateTime.now
  const job = new AgentJob({ id, prompt, status: "queued", createdAt })
  const createdAtIso = DateTime.formatIso(createdAt)

  return { job, createdAtIso } as const
})
