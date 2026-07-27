import { Schema } from "effect"

/**
  * @since
  * @category error
  */
export class GitHubAppCreationError extends Schema.TaggedErrorClass<GitHubAppCreationError>()(
  "GitHubAppCreationError",
  { operation: Schema.String }
) {}

export class GitHubRepositoryAccessError extends Schema.TaggedErrorClass<GitHubRepositoryAccessError>()(
  "GitHubRepositoryAccessError",
  { operation: Schema.String }
) {}
