import { Schema } from "effect"

/**
  * @since
  * @category error
  */
export class InvalidAgentPrompt extends Schema.TaggedErrorClass<InvalidAgentPrompt>()(
  "InvalidAgentPrompt",
  { cause: Schema.Defect() }
) { }

/**
  * @since
  * @category error
  */
export class InvalidTargetRepository extends Schema.TaggedErrorClass<InvalidTargetRepository>()(
  "InvalidTargetRepository",
  { cause: Schema.Defect() }
) { }

/**
  * @since
  * @category error
  */
export class QueueJobError extends Schema.TaggedErrorClass<QueueJobError>()(
  "QueueJobError",
  { cause: Schema.Defect() }
) { }

/**
  * @since
  * @category error
  */
export class AgentJobOperationError extends Schema.TaggedErrorClass<AgentJobOperationError>()(
  "AgentJobOperationError",
  { cause: Schema.Defect() }
) { }

/**
  * @since
  * @category error
  */
export class AgentJobNotFound extends Schema.TaggedErrorClass<AgentJobNotFound>()(
  "AgentJobNotFound",
  { id: Schema.String }
) { }

/**
  * @since
  * @category error
  */
export class AgentJobRepositoryError extends Schema.TaggedErrorClass<AgentJobRepositoryError>()(
  "AgentJobRepositoryError",
  { cause: Schema.Defect() }
) { }
