import { Context, Effect } from "effect"
import type {
  AgentJob,
  AgentJobEvent,
  AgentJobId
} from "../agent-job.model.ts"
import {
  AgentJobNotFound,
  AgentJobOperationError,
  InvalidAgentPrompt,
  InvalidTargetRepository,
  QueueJobError
} from "../error.ts"

/**
  * @since
  * @category service interface
  */
export interface IAgentJobService {
  /**
    * @since
    * @category service interface method
    */
  readonly queueJob: (
    prompt: string,
    targetRepository?: string
  ) => Effect.Effect<AgentJob, InvalidAgentPrompt | InvalidTargetRepository | QueueJobError>

  /**
    * @since
    * @category service interface method
    */
  readonly claim: (
    id: AgentJobId
  ) => Effect.Effect<boolean, AgentJobOperationError>

  /**
    * @since
    * @category service interface method
    */
  readonly appendEvent: (
    id: AgentJobId,
    sequence: number,
    message: string
  ) => Effect.Effect<AgentJobEvent, AgentJobOperationError>

  /**
    * @since
    * @category service interface method
    */
  readonly succeed: (
    id: AgentJobId,
    result: string
  ) => Effect.Effect<void, AgentJobOperationError>

  /**
    * @since
    * @category service interface method
    */
  readonly fail: (
    id: AgentJobId,
    failure: string
  ) => Effect.Effect<void, AgentJobOperationError>

  /**
    * @since
    * @category service interface method
    */
  readonly get: (
    id: AgentJobId
  ) => Effect.Effect<AgentJob, AgentJobNotFound | AgentJobOperationError>

  /**
    * @since
    * @category service interface method
    */
  readonly listEventsAfter: (
    id: AgentJobId,
    sequence: number
  ) => Effect.Effect<ReadonlyArray<AgentJobEvent>, AgentJobOperationError>

  /**
    * @since
    * @category service interface method
    */
  readonly watchJob: (
    id: AgentJobId
  ) => Effect.Effect<void, AgentJobNotFound | AgentJobOperationError | Error>
}

/**
  * @since
  * @category service
  */
export class AgentJobService extends Context.Service<
  AgentJobService,
  IAgentJobService
>()("AgentJobService") { }
