import { Context, Effect } from "effect"
import type {
  AgentJob,
  AgentJobEvent,
  AgentJobId
} from "../agent-job.model.ts"
import type { AgentJobRepositoryError } from "../error.ts"

/**
  * @since
  * @category service interface
  */
export interface IAgentJobRepository {
  /**
    * @since
    * @category service interface method
    */
  readonly put: (
    job: AgentJob,
    createdAtIso: string
  ) => Effect.Effect<void, AgentJobRepositoryError>

  /**
    * @since
    * @category service interface method
    */
  readonly claim: (
    id: AgentJobId,
    startedAtIso: string
  ) => Effect.Effect<boolean, AgentJobRepositoryError>

  /**
    * @since
    * @category service interface method
    */
  readonly appendEvent: (
    event: AgentJobEvent,
    createdAtIso: string
  ) => Effect.Effect<void, AgentJobRepositoryError>

  /**
    * @since
    * @category service interface method
    */
  readonly succeed: (
    id: AgentJobId,
    result: string,
    completedAtIso: string
  ) => Effect.Effect<void, AgentJobRepositoryError>

  /**
    * @since
    * @category service interface method
    */
  readonly fail: (
    id: AgentJobId,
    failure: string,
    completedAtIso: string
  ) => Effect.Effect<void, AgentJobRepositoryError>

  /**
    * @since
    * @category service interface method
    */
  readonly get: (
    id: AgentJobId
  ) => Effect.Effect<AgentJob | undefined, AgentJobRepositoryError>

  /**
    * @since
    * @category service interface method
    */
  readonly listEventsAfter: (
    id: AgentJobId,
    sequence: number
  ) => Effect.Effect<ReadonlyArray<AgentJobEvent>, AgentJobRepositoryError>
}

/**
  * @since
  * @category service
  */
export class AgentJobRepository extends Context.Service<
  AgentJobRepository,
  IAgentJobRepository
>()("AgentJobRepository") { }
