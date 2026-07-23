import { afterEach, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialize } from "../src/command/init/index.ts"

const homes: Array<string> = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const makeHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "fireclanker-test-"))
  homes.push(home)
  return home
}

const runCli = (home: string, ...args: ReadonlyArray<string>) => Bun.spawn(
  ["bun", "run", "src/index.ts", ...args],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe"
  }
)

test("init writes the required deployment configuration", async () => {
  const home = await makeHome()
  const previousHome = process.env.HOME
  process.env.HOME = home
  const answers = ["fireclanker-dev", "us-east-1", "sandbox-us"]

  try {
    await Effect.runPromise(initialize(
      () => Effect.succeed(answers.shift()!),
      () => Effect.void
    ).pipe(Effect.provide(BunServices.layer)))
    expect(JSON.parse(await readFile(join(home, ".config/fireclanker/config.json"), "utf8"))).toEqual({
      name: "fireclanker-dev",
      region: "us-east-1",
      awsProfile: "sandbox-us"
    })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

for (const [command, args] of [
  ["deploy", []],
  ["destroy", []],
  ["run", ["hello"]]
] as const) {
  test(`${command} requires initialization before accessing AWS`, async () => {
    const home = await makeHome()
    const process = runCli(home, command, ...args)
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text()
    ])

    expect(exitCode).not.toBe(0)
    expect(`${stdout}\n${stderr}`).toContain("fireclanker init")
  })
}

test("init rejects configuration flags", async () => {
  const home = await makeHome()
  const process = runCli(home, "init", "--name", "fireclanker")

  expect(await process.exited).not.toBe(0)
})
