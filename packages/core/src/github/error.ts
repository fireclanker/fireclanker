import { Schema } from "effect"

/**
  * @since
  * @category error
  */
export class GitHubAppCreationError extends Schema.TaggedErrorClass<GitHubAppCreationError>()(
  "GitHubAppCreationError",
  { operation: Schema.String }
) {}
