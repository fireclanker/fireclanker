import { Context, Effect, Redacted } from "effect"
import type {
  AgentJobId,
  SourceBranch,
  SourceRepository
} from "../../agent-job/agent-job.model.ts"
import type {
  ChangeSet,
  PublicationDecision,
  PublicationOption,
  PublicationResult
} from "../../publication/publication.model.ts"
import type { GitHubRepositoryAccessError } from "../error.ts"

export interface IGitHubRepositoryAccess {
  readonly checkoutToken: (
    sourceRepository: SourceRepository
  ) => Effect.Effect<Redacted.Redacted<string> | undefined, GitHubRepositoryAccessError>

  readonly revokeToken: (
    token: Redacted.Redacted<string>
  ) => Effect.Effect<void>

  readonly publicationOptions: (
    sourceRepository: SourceRepository,
    jobId: AgentJobId,
    sourceBranch?: SourceBranch
  ) => Effect.Effect<ReadonlyArray<PublicationOption>, GitHubRepositoryAccessError>

  readonly publish: (
    request: {
      readonly sourceRepository: SourceRepository
      readonly sourceBranch?: SourceBranch
      readonly jobId: AgentJobId
      readonly offeredOptionIds: ReadonlyArray<string>
      readonly baseSha: string
      readonly changes: ChangeSet
      readonly decision: PublicationDecision
    }
  ) => Effect.Effect<PublicationResult | undefined, GitHubRepositoryAccessError>
}

export class GitHubRepositoryAccess extends Context.Service<
  GitHubRepositoryAccess,
  IGitHubRepositoryAccess
>()("GitHubRepositoryAccess") {}
