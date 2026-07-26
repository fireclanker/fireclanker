import { Schema } from "effect"

/**
  * @since
  * @category error
  */
export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()(
  "RepositoryError",
  { cause: Schema.Defect() }
) { }
