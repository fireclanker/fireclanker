import type { AgentHarness, AgentJob, Publication } from "@fireclanker/core"
import * as AWS from "alchemy/AWS"
import type { Effect, Stream } from "effect"
import type { AgentMicrovmError } from "./agent-microvm-response.ts"

export interface AgentMicrovmRunRequest {
  readonly prompt: string
  readonly sourceRepository: AgentJob.SourceRepository
  readonly sourceBranch?: AgentJob.SourceBranch
  readonly publicationOptions: ReadonlyArray<Publication.PublicationOption>
  readonly repositoryAccessToken?: string
}

export type AgentMicrovmEvent =
  | {
    readonly _tag: "log"
    readonly sequence: number
    readonly message: string
  }
  | {
    readonly _tag: "completed"
    readonly sequence: number
    readonly result: AgentHarness.AgentHarnessRunResult
  }
  | {
    readonly _tag: "failed"
    readonly sequence: number
    readonly error: AgentMicrovmError
  }

export interface AgentMicrovmShape {
  readonly start: (
    request: AgentMicrovmRunRequest
  ) => Effect.Effect<void>
  readonly events: () => Stream.Stream<AgentMicrovmEvent>
  readonly watch: (
    request: { readonly afterSequence: number }
  ) => Stream.Stream<AgentMicrovmEvent>
}

export class AgentMicrovm extends AWS.Lambda.MicrovmImage<
  AgentMicrovm,
  AgentMicrovmShape
>()("AgentMicrovm") {}
