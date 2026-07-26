import { Schema } from "effect"

/**
  * @since
  * @category error
  */
export class AgentHarnessError extends Schema.TaggedErrorClass<AgentHarnessError>()(
  "AgentHarnessError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) { }
