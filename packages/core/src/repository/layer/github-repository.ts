import {
  lstat,
  readFile,
  readlink,
  realpath
} from "node:fs/promises"
import {
  dirname,
  relative,
  resolve,
  sep
} from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  type FileChange,
  MAX_PUBLICATION_BYTES,
  MAX_PUBLICATION_FILES
} from "../../publication/publication.model.ts"
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
    const gitEnvironment = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_TERMINAL_PROMPT: "0"
    } as const

    const repositoryError = () => new RepositoryError({
      cause: new Error("Git repository operation failed")
    })

    const gitOutput = (
      destination: string,
      args: ReadonlyArray<string>
    ) => spawner.string(ChildProcess.make("git", args, {
      shell: false,
      extendEnv: false,
      cwd: destination,
      env: gitEnvironment,
      stdin: "ignore",
      stderr: "ignore"
    })).pipe(Effect.mapError(repositoryError))

    const checkout: IRepository["checkout"] = Effect.fn("GitHubRepository.checkout")(
      function*({
        sourceRepository,
        sourceBranch,
        destination,
        candidateBaseShas = [],
        authentication
      }) {
        const authenticationEnvironment = authentication === undefined
          ? {}
          : {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
              `x-access-token:${Redacted.value(authentication.token)}`
            ).toString("base64")}`
          }
        const exitCode = yield* spawner.exitCode(ChildProcess.make("git", [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--no-tags",
          ...(sourceBranch === undefined ? [] : ["--branch", sourceBranch]),
          `https://github.com/${sourceRepository}.git`,
          destination
        ], {
          shell: false,
          extendEnv: false,
          env: {
            ...gitEnvironment,
            HOME: dirname(destination),
            ...authenticationEnvironment
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
        if (
          candidateBaseShas.length > 100 ||
          candidateBaseShas.some((sha) => !/^[0-9a-f]{40}$/.test(sha))
        ) {
          return yield* Effect.fail(repositoryError())
        }
        if (candidateBaseShas.length > 0) {
          const fetchExitCode = yield* spawner.exitCode(ChildProcess.make("git", [
            "fetch",
            "--depth",
            "1",
            "--no-tags",
            "origin",
            ...new Set(candidateBaseShas)
          ], {
            shell: false,
            extendEnv: false,
            cwd: destination,
            env: {
              ...gitEnvironment,
              HOME: dirname(destination),
              ...authenticationEnvironment
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore"
          })).pipe(Effect.mapError(repositoryError))
          if (fetchExitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* Effect.fail(repositoryError())
          }
        }
        const baseSha = (yield* gitOutput(destination, ["rev-parse", "HEAD"])).trim()
        if (!/^[0-9a-f]{40}$/.test(baseSha)) {
          return yield* Effect.fail(repositoryError())
        }
        return { baseSha }
      }
    )

    const changes: IRepository["changes"] = Effect.fn("GitHubRepository.changes")(
      function*({ destination, baseSha }) {
        if (!/^[0-9a-f]{40}$/.test(baseSha)) {
          return yield* Effect.fail(repositoryError())
        }
        const tracked = yield* gitOutput(destination, [
          "diff",
          "--name-status",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          baseSha,
          "--",
          "."
        ])
        const untracked = yield* gitOutput(destination, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          "."
        ])
        const statuses = tracked.split("\0")
        if (statuses.at(-1) === "") statuses.pop()
        if (statuses.length % 2 !== 0) {
          return yield* Effect.fail(repositoryError())
        }
        const candidates = new Map<string, "delete" | "upsert">()
        for (let index = 0; index < statuses.length; index += 2) {
          const status = statuses[index]!
          const path = statuses[index + 1]!
          candidates.set(path, status === "D" ? "delete" : "upsert")
        }
        for (const path of untracked.split("\0")) {
          if (path) candidates.set(path, "upsert")
        }
        if (candidates.size > MAX_PUBLICATION_FILES) {
          return yield* Effect.fail(repositoryError())
        }

        const workspace = yield* Effect.tryPromise({
          try: () => realpath(destination),
          catch: repositoryError
        })
        const output: Array<FileChange> = []
        let totalBytes = 0
        for (const [path, kind] of [...candidates].sort(([left], [right]) =>
          left.localeCompare(right)
        )) {
          const segments = path.split("/")
          if (
            !path || path.startsWith("/") || path.includes("\0") ||
            segments.some((segment) =>
              segment === "" || segment === "." || segment === ".." ||
              segment.toLowerCase() === ".git"
            )
          ) {
            return yield* Effect.fail(repositoryError())
          }
          if (kind === "delete") {
            output.push({ kind, path })
            continue
          }

          const absolute = resolve(workspace, path)
          const parent = yield* Effect.tryPromise({
            try: () => realpath(dirname(absolute)),
            catch: repositoryError
          })
          const parentRelative = relative(workspace, parent)
          if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
            return yield* Effect.fail(repositoryError())
          }
          const stats = yield* Effect.tryPromise({
            try: () => lstat(absolute),
            catch: repositoryError
          })
          let content: Buffer
          let mode: "100644" | "100755" | "120000"
          if (stats.isSymbolicLink()) {
            content = Buffer.from(yield* Effect.tryPromise({
              try: () => readlink(absolute),
              catch: repositoryError
            }))
            mode = "120000"
          } else if (stats.isFile()) {
            const canonical = yield* Effect.tryPromise({
              try: () => realpath(absolute),
              catch: repositoryError
            })
            const canonicalRelative = relative(workspace, canonical)
            if (
              canonicalRelative === ".." ||
              canonicalRelative.startsWith(`..${sep}`)
            ) {
              return yield* Effect.fail(repositoryError())
            }
            content = yield* Effect.tryPromise({
              try: () => readFile(canonical),
              catch: repositoryError
            })
            mode = (stats.mode & 0o111) === 0 ? "100644" : "100755"
          } else {
            return yield* Effect.fail(repositoryError())
          }
          totalBytes += content.byteLength
          if (totalBytes > MAX_PUBLICATION_BYTES) {
            return yield* Effect.fail(repositoryError())
          }
          output.push({
            kind: "upsert",
            path,
            mode,
            contentBase64: content.toString("base64")
          })
        }
        return output
      }
    )

    const reset: IRepository["reset"] = Effect.fn("GitHubRepository.reset")(
      function*({ destination, baseSha }) {
        if (!/^[0-9a-f]{40}$/.test(baseSha)) {
          return yield* Effect.fail(repositoryError())
        }
        for (const args of [
          ["reset", "--hard", baseSha],
          ["clean", "-fdx"]
        ]) {
          const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, {
            shell: false,
            extendEnv: false,
            cwd: destination,
            env: { ...gitEnvironment, HOME: dirname(destination) },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore"
          })).pipe(Effect.mapError(repositoryError))
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* Effect.fail(repositoryError())
          }
        }
      }
    )

    return Repository.of({ checkout, changes, reset })
  })
)
