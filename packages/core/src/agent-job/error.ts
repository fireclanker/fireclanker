import { Schema } from "effect"

export class InvalidAgentPrompt extends Schema.TaggedErrorClass<InvalidAgentPrompt>()(
  "InvalidAgentPrompt",
  { cause: Schema.Defect() }
) {}

export class QueueJobError extends Schema.TaggedErrorClass<QueueJobError>()(
  "QueueJobError",
  { cause: Schema.Defect() }
) {}

export class AgentJobRepositoryError extends Schema.TaggedErrorClass<AgentJobRepositoryError>()(
  "AgentJobRepositoryError",
  { cause: Schema.Defect() }
) {}
