import { Context, Effect, Redacted } from "effect"
import type { SourceRepository } from "../../agent-job/agent-job.model.ts"
import type { GitHubRepositoryAccessError } from "../error.ts"

export interface IGitHubRepositoryAccess {
  readonly checkoutToken: (
    sourceRepository: SourceRepository
  ) => Effect.Effect<Redacted.Redacted<string> | undefined, GitHubRepositoryAccessError>
}

export class GitHubRepositoryAccess extends Context.Service<
  GitHubRepositoryAccess,
  IGitHubRepositoryAccess
>()("GitHubRepositoryAccess") {}
