import * as AWS from "alchemy/AWS"
import { Effect } from "effect"
import { runOpencodeWithMock } from "../opencode/run.ts"
import dockerfile from "./Dockerfile?raw" with { type: "text" }

export class AgentMicrovm extends AWS.Lambda.MicrovmImage<
  AgentMicrovm,
  {
    run: (prompt: string) => Effect.Effect<{
      readonly result: string
      readonly logs: ReadonlyArray<string>
    }>
  }
>()("AgentMicrovm") {}

const AgentMicrovmBuildRole = AWS.IAM.Role("AgentMicrovmBuildRole")

export default AgentMicrovm.make(
  AgentMicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      dockerfile,
      buildRole,
      runtime: "node" as const,
      resources: [{ minimumMemoryInMiB: 1024 }],
      cpuConfigurations: [{ architecture: "ARM_64" as const }]
    }))
  ),
  Effect.succeed({
    run: (prompt: string) => runOpencodeWithMock(prompt).pipe(
      Effect.tap((result) => Effect.logInfo("OpenCode mock execution completed", { result })),
      Effect.map((result) => ({
        result,
        logs: ["[microvm] OpenCode completed against the mock LLM"]
      })),
      Effect.orDie
    )
  })
)
