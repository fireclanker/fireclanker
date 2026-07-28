import { Context, Effect, Redacted } from "effect"
import type {
  SourceBranch,
  SourceRepository
} from "../../agent-job/agent-job.model.ts"
import type { ChangeSet } from "../../publication/publication.model.ts"
import type { RepositoryError } from "../error.ts"

export interface RepositoryCheckoutRequest {
  readonly sourceRepository: SourceRepository
  readonly sourceBranch?: SourceBranch
  readonly destination: string
  readonly candidateBaseShas?: ReadonlyArray<string>
  readonly authentication?: {
    readonly token: Redacted.Redacted<string>
  }
}

export interface RepositoryCheckout {
  readonly baseSha: string
}

export interface RepositoryChangesRequest {
  readonly destination: string
  readonly baseSha: string
}

export interface RepositoryResetRequest {
  readonly destination: string
  readonly baseSha: string
}

/**
  * @since
  * @category service interface
  */
export interface IRepository {
  /**
    * @since
    * @category service interface method
    */
  readonly checkout: (
    request: RepositoryCheckoutRequest
  ) => Effect.Effect<RepositoryCheckout, RepositoryError>

  readonly changes: (
    request: RepositoryChangesRequest
  ) => Effect.Effect<ChangeSet, RepositoryError>

  readonly reset: (
    request: RepositoryResetRequest
  ) => Effect.Effect<void, RepositoryError>
}

/**
  * @since
  * @category service
  */
export class Repository extends Context.Service<
  Repository,
  IRepository
>()("Repository") { }
