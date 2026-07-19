import { Context, Effect } from "effect"
import type { AgentJob } from "../agent-job.model.ts"
import { InvalidAgentPrompt, QueueJobError } from "../error.ts"

export interface IAgentJobService {
  readonly queueJob: (
    prompt: string
  ) => Effect.Effect<AgentJob, InvalidAgentPrompt | QueueJobError>
}

export class AgentJobService extends Context.Service<
  AgentJobService,
  IAgentJobService
>()("AgentJobService") {}
