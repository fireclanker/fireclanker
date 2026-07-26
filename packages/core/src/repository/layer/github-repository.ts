import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RepositoryError } from "../error.ts"
import {
  type IRepository,
  Repository
} from "../service/repository.service.ts"

/**
  * @since
  * @category layer
  */
export const GitHubRepository = Layer.effect(
  Repository,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const checkout: IRepository["checkout"] = Effect.fn("GitHubRepository.checkout")(
      function*({ sourceRepository, destination }) {
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
          Effect.mapError(() => new RepositoryError({
            cause: new Error("Unable to start Git process")
          }))
        )

        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* Effect.fail(new RepositoryError({
            cause: new Error(`Git exited with code ${exitCode}`)
          }))
        }
      }
    )

    return Repository.of({ checkout })
  })
)
