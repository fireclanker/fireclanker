import { Context, Effect } from "effect"
import type { AgentJob } from "../agent-job.model.ts"
import type { AgentJobRepositoryError } from "../error.ts"

export interface IAgentJobRepository {
  readonly put: (
    job: AgentJob,
    createdAtIso: string
  ) => Effect.Effect<void, AgentJobRepositoryError>
}

export class AgentJobRepository extends Context.Service<
  AgentJobRepository,
  IAgentJobRepository
>()("AgentJobRepository") {}
