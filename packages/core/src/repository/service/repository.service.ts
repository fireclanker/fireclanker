import { Context, Effect } from "effect"
import type { SourceRepository } from "../../agent-job/agent-job.model.ts"
import type { RepositoryError } from "../error.ts"

export interface RepositoryCheckoutRequest {
  readonly sourceRepository: SourceRepository
  readonly destination: string
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
