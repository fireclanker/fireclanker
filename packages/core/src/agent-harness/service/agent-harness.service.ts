import { Context, Effect } from "effect"
import type { SourceRepository } from "../../agent-job/agent-job.model.ts"
import type { RepositoryCheckoutRequest } from "../../repository/service/repository.service.ts"
import { AgentHarnessError } from "../error.ts"

export interface AgentHarnessRunRequest {
  readonly prompt: string
  readonly sourceRepository: SourceRepository
  readonly repositoryAuthentication?: RepositoryCheckoutRequest["authentication"]
}

export interface AgentHarnessRunResult {
  readonly result: string
  readonly logs: ReadonlyArray<string>
}

/**
  * @since
  * @category service interface
  */
export interface IAgentHarness {
  /**
    * @since
    * @category service interface method
    */
  readonly run: (
    request: AgentHarnessRunRequest
  ) => Effect.Effect<AgentHarnessRunResult, AgentHarnessError>
}

/**
  * @since
  * @category service
  */
export class AgentHarness extends Context.Service<
  AgentHarness,
  IAgentHarness
>()("AgentHarness") { }
