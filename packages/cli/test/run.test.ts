import { expect, test } from "bun:test"

const runCli = (...args: ReadonlyArray<string>) => Bun.spawn(
  ["bun", "run", "src/index.ts", ...args],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe"
  }
)

const output = async (process: ReturnType<typeof runCli>) => {
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  return { exitCode, text: `${stdout}\n${stderr}` }
}

test("run requires a Source Repository", async () => {
  const result = await output(runCli("run", "inspect the repository"))

  expect(result.exitCode).not.toBe(0)
  expect(result.text).toContain("--repo")
})

test("run rejects repository URLs", async () => {
  const result = await output(runCli(
    "run",
    "--repo",
    "https://github.com/fireclanker/example",
    "inspect the repository"
  ))

  expect(result.exitCode).not.toBe(0)
  expect(result.text).toContain("Source Repository must use the GitHub owner/name[@branch] format")
})

test("run rejects an invalid explicit Source Branch", async () => {
  const result = await output(runCli(
    "run",
    "--repo",
    "fireclanker/example@feature//nested",
    "inspect the repository"
  ))

  expect(result.exitCode).not.toBe(0)
  expect(result.text).toContain("Source Branch must be a valid Git branch name")
})

test("run help describes the Source Repository option", async () => {
  const result = await output(runCli("run", "--help"))

  expect(result.exitCode).toBe(0)
  expect(result.text).toContain("--repo")
  expect(result.text).toContain("GitHub Source Repository")
  expect(result.text).toContain("owner/name[@branch]")
})
