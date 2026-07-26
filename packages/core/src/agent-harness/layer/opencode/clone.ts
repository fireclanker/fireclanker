import { dirname } from "node:path"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { SourceRepository } from "../../../agent-job/agent-job.model.ts"
import { OpenCodeError } from "./effect-sdk.ts"

export const clonePublicRepository = Effect.fn("OpenCode.clonePublicRepository")(
  function*({ sourceRepository, destination }: {
    readonly sourceRepository: SourceRepository
    readonly destination: string
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      `https://github.com/${sourceRepository}.git`,
      destination
    ], {
      shell: false,
      extendEnv: false,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: dirname(destination),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_TERMINAL_PROMPT: "0"
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    })).pipe(
      Effect.mapError((cause) => new OpenCodeError({
        operation: "clone-public-repository",
        cause
      }))
    )

    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* Effect.fail(new OpenCodeError({
        operation: "clone-public-repository",
        cause: new Error(`Git exited with code ${exitCode}`)
      }))
    }
  }
)
