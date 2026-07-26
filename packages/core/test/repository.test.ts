import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Layer, Schema, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SourceRepository } from "../src/agent-job/agent-job.model.ts"
import {
  GitHubRepository,
  Repository
} from "../src/repository/index.ts"

const sourceRepository = Schema.decodeUnknownSync(SourceRepository)(
  "Fireclanker/example.repo"
)

const spawnerLayer = (
  code: number,
  inspect?: (command: ChildProcess.Command) => void
) => Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(Effect.fnUntraced(function*(command) {
    inspect?.(command)
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    })
  }))
)

const failingSpawnerLayer = (diagnostic: string) => Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.fail(PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "spawn",
    description: diagnostic,
    cause: new Error(diagnostic)
  })))
)

test("clones a public Source Repository with an isolated Git environment", async () => {
  let observed: ChildProcess.Command | undefined

  await Effect.runPromise(Effect.gen(function*() {
    const repository = yield* Repository
    yield* repository.checkout({
      sourceRepository,
      destination: "/tmp/run/workspace"
    })
  }).pipe(Effect.provide(
    GitHubRepository.pipe(Layer.provide(spawnerLayer(0, (command) => {
      observed = command
    })))
  )))

  expect(observed).toBeDefined()
  expect(ChildProcess.isStandardCommand(observed!)).toBe(true)
  if (!ChildProcess.isStandardCommand(observed!)) return
  expect(observed.command).toBe("git")
  expect(observed.args).toEqual([
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "https://github.com/Fireclanker/example.repo.git",
    "/tmp/run/workspace"
  ])
  expect(observed.options.shell).toBe(false)
  expect(observed.options.extendEnv).toBe(false)
  expect(observed.options.env).toEqual({
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/run",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0"
  })
  expect(observed.options.stdin).toBe("ignore")
  expect(observed.options.stdout).toBe("ignore")
  expect(observed.options.stderr).toBe("ignore")
})

test("reports a sanitized failure when Git cannot clone", async () => {
  const error = await Effect.runPromise(Effect.gen(function*() {
    const repository = yield* Repository
    yield* repository.checkout({
      sourceRepository,
      destination: "/tmp/run/workspace"
    })
  }).pipe(
    Effect.provide(GitHubRepository.pipe(Layer.provide(spawnerLayer(128)))),
    Effect.flip
  ))

  expect(error._tag).toBe("RepositoryError")
  expect(String(error.cause)).not.toContain("Fireclanker/example.repo")
})

test("sanitizes Git process failures", async () => {
  const diagnostic = "spawn https://github.com/Fireclanker/example.repo.git failed"
  const error = await Effect.runPromise(Effect.gen(function*() {
    const repository = yield* Repository
    yield* repository.checkout({
      sourceRepository,
      destination: "/tmp/run/workspace"
    })
  }).pipe(
    Effect.provide(GitHubRepository.pipe(Layer.provide(failingSpawnerLayer(diagnostic)))),
    Effect.flip
  ))

  expect(error._tag).toBe("RepositoryError")
  expect(String(error.cause)).toBe("Error: Unable to start Git process")
  expect(String(error.cause)).not.toContain(diagnostic)
})

test.skipIf(
  Bun.which("git") === null || process.env.FIRECLANKER_CLONE_INTEGRATION !== "1"
)("clones a public GitHub repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "fireclanker-clone-test-"))
  try {
    await Effect.runPromise(Effect.gen(function*() {
      const repository = yield* Repository
      yield* repository.checkout({
        sourceRepository: Schema.decodeUnknownSync(SourceRepository)(
          "octocat/Hello-World"
        ),
        destination: join(root, "workspace")
      })
    }).pipe(Effect.provide(
      GitHubRepository.pipe(Layer.provide(NodeServices.layer))
    )))

    expect(await readFile(join(root, "workspace", "README"), "utf8")).toContain(
      "Hello World"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
