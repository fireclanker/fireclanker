import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Schema, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SourceBranch,
  SourceRepository
} from "../src/agent-job/agent-job.model.ts"
import {
  GitHubRepository,
  Repository
} from "../src/repository/index.ts"

const sourceRepository = Schema.decodeUnknownSync(SourceRepository)(
  "Fireclanker/example.repo"
)
const sourceBranch = Schema.decodeUnknownSync(SourceBranch)("feature/explicit-start")
const baseSha = "0123456789abcdef0123456789abcdef01234567"

const spawnerLayer = (
  code: number,
  inspect?: (command: ChildProcess.Command) => void
) => Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(Effect.fnUntraced(function*(command) {
    inspect?.(command)
    const stdout = ChildProcess.isStandardCommand(command) &&
      command.args[0] === "rev-parse"
      ? Stream.make(Buffer.from(`${baseSha}\n`))
      : Stream.empty
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      stdin: Sink.drain,
      stdout,
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

test("clones an explicit Source Branch with an isolated Git environment", async () => {
  let observed: ChildProcess.Command | undefined

  await Effect.runPromise(Effect.gen(function*() {
    const repository = yield* Repository
    yield* repository.checkout({
      sourceRepository,
      sourceBranch,
      destination: "/tmp/run/workspace"
    })
  }).pipe(Effect.provide(
    GitHubRepository.pipe(Layer.provide(spawnerLayer(0, (command) => {
      if (ChildProcess.isStandardCommand(command) && command.args[0] === "clone") {
        observed = command
      }
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
    "--branch",
    "feature/explicit-start",
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

test("authenticates a private checkout only through the clone process environment", async () => {
  let observed: ChildProcess.Command | undefined
  const token = "ghs_checkout_token"

  await Effect.runPromise(Effect.gen(function*() {
    const repository = yield* Repository
    yield* repository.checkout({
      sourceRepository,
      destination: "/tmp/run/workspace",
      authentication: { token: Redacted.make(token) }
    })
  }).pipe(Effect.provide(
    GitHubRepository.pipe(Layer.provide(spawnerLayer(0, (command) => {
      if (ChildProcess.isStandardCommand(command) && command.args[0] === "clone") {
        observed = command
      }
    })))
  )))

  expect(observed).toBeDefined()
  expect(ChildProcess.isStandardCommand(observed!)).toBe(true)
  if (!ChildProcess.isStandardCommand(observed!)) return
  expect(observed.args.join(" ")).not.toContain(token)
  expect(observed.options.extendEnv).toBe(false)
  expect(observed.options.env).toMatchObject({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  })
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

test("captures bounded tracked, untracked, deleted, executable, and symlink changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fireclanker-changes-test-"))
  const git = async (...args: ReadonlyArray<string>) => {
    const process = Bun.spawn(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "pipe"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text()
    ])
    if (exitCode !== 0) throw new Error(stderr)
    return stdout.trim()
  }

  try {
    await git("init", "-q")
    await git("config", "user.email", "fireclanker@example.com")
    await git("config", "user.name", "Fireclanker")
    await writeFile(join(root, "tracked.txt"), "before\n")
    await writeFile(join(root, "deleted.txt"), "remove me\n")
    await git("add", ".")
    await git("commit", "-qm", "base")
    const capturedBaseSha = await git("rev-parse", "HEAD")

    await writeFile(join(root, "tracked.txt"), "after\n")
    await unlink(join(root, "deleted.txt"))
    await writeFile(join(root, "script.sh"), "#!/bin/sh\necho hello\n")
    await chmod(join(root, "script.sh"), 0o755)
    await symlink("tracked.txt", join(root, "tracked-link"))

    const changes = await Effect.runPromise(Effect.gen(function*() {
      const repository = yield* Repository
      return yield* repository.changes({
        destination: root,
        baseSha: capturedBaseSha
      })
    }).pipe(Effect.provide(
      GitHubRepository.pipe(Layer.provide(NodeServices.layer))
    )))

    expect(changes).toEqual([
      { kind: "delete", path: "deleted.txt" },
      {
        kind: "upsert",
        path: "script.sh",
        mode: "100755",
        contentBase64: Buffer.from("#!/bin/sh\necho hello\n").toString("base64")
      },
      {
        kind: "upsert",
        path: "tracked-link",
        mode: "120000",
        contentBase64: Buffer.from("tracked.txt").toString("base64")
      },
      {
        kind: "upsert",
        path: "tracked.txt",
        mode: "100644",
        contentBase64: Buffer.from("after\n").toString("base64")
      }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
