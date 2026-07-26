import { AgentJob } from "@fireclanker/core"
import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Layer, Schema, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clonePublicRepository } from "../src/opencode/clone.ts"

const sourceRepository = Schema.decodeUnknownSync(AgentJob.SourceRepository)(
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

test("clones a public Source Repository with an isolated Git environment", async () => {
  let observed: ChildProcess.Command | undefined

  await Effect.runPromise(clonePublicRepository({
    sourceRepository,
    destination: "/tmp/run/workspace"
  }).pipe(
    Effect.provide(spawnerLayer(0, (command) => {
      observed = command
    }))
  ))

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
  expect(observed.options.env).toMatchObject({
    HOME: "/tmp/run",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0"
  })
})

test("reports a sanitized failure when Git cannot clone", async () => {
  const error = await Effect.runPromise(clonePublicRepository({
    sourceRepository,
    destination: "/tmp/run/workspace"
  }).pipe(
    Effect.provide(spawnerLayer(128)),
    Effect.flip
  ))

  expect(error.operation).toBe("clone-public-repository")
  expect(String(error.cause)).not.toContain("Fireclanker/example.repo")
})

test.skipIf(
  Bun.which("git") === null || process.env.FIRECLANKER_CLONE_INTEGRATION !== "1"
)("clones a public GitHub repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "fireclanker-clone-test-"))
  try {
    await Effect.runPromise(clonePublicRepository({
      sourceRepository: Schema.decodeUnknownSync(AgentJob.SourceRepository)(
        "octocat/Hello-World"
      ),
      destination: join(root, "workspace")
    }).pipe(Effect.provide(NodeServices.layer)))

    expect(await readFile(join(root, "workspace", "README"), "utf8")).toContain(
      "Hello World"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
