import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cliDirectory = new URL("..", import.meta.url).pathname
const deploymentTimeoutMs = 30 * 60 * 1000
const agentRunTimeoutMs = 15 * 60 * 1000

const requiredEnvironment = [
  "FIRECLANKER_E2E_NAME",
  "FIRECLANKER_E2E_AWS_REGION",
  "FIRECLANKER_E2E_AWS_PROFILE",
  "FIRECLANKER_E2E_GITHUB_ORGANIZATION",
  "FIRECLANKER_E2E_REPOSITORY",
  "FIRECLANKER_E2E_MARKER"
] as const

type E2eEnvironment = Record<typeof requiredEnvironment[number], string>

const readE2eEnvironment = (): E2eEnvironment => {
  const missing = requiredEnvironment.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `Missing Fireclanker E2E environment: ${missing.join(", ")}`
    )
  }

  const environment = Object.fromEntries(
    requiredEnvironment.map((name) => [name, process.env[name]!.trim()])
  ) as E2eEnvironment
  if (!environment.FIRECLANKER_E2E_NAME.startsWith("fc-e2e")) {
    throw new Error("FIRECLANKER_E2E_NAME must start with the reserved 'fc-e2e' prefix")
  }
  return environment
}

const tail = (text: string, length = 12_000): string =>
  text.length <= length ? text : text.slice(-length)

const runCli = async (
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined>,
  timeoutMs: number
) => {
  const child = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: cliDirectory,
    env: environment,
    stdout: "pipe",
    stderr: "pipe"
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    const output = `${stdout}\n${stderr}`
    if (timedOut) {
      throw new Error(
        `fireclanker ${args[0]} exceeded ${timeoutMs}ms\n${tail(output)}`
      )
    }
    if (exitCode !== 0) {
      throw new Error(
        `fireclanker ${args[0]} exited ${exitCode}\n${tail(output)}`
      )
    }
    return output
  } finally {
    clearTimeout(timeout)
  }
}

test(
  "CLI deploys Fireclanker and completes an Agent Run",
  async () => {
    const e2e = readE2eEnvironment()
    const configHome = await mkdtemp(join(tmpdir(), "fireclanker-e2e-"))
    const configDirectory = join(configHome, "fireclanker")
    await mkdir(configDirectory, { recursive: true })
    await writeFile(
      join(configDirectory, "config.json"),
      `${JSON.stringify({
        name: e2e.FIRECLANKER_E2E_NAME,
        region: e2e.FIRECLANKER_E2E_AWS_REGION,
        awsProfile: e2e.FIRECLANKER_E2E_AWS_PROFILE,
        githubOrganization: e2e.FIRECLANKER_E2E_GITHUB_ORGANIZATION
      }, null, 2)}\n`
    )

    const environment = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      ALCHEMY_TELEMETRY_DISABLED: "1",
      NO_COLOR: "1"
    }

    try {
      await runCli(["deploy"], environment, deploymentTimeoutMs)
      const output = await runCli([
        "run",
        "--watch",
        "--repo",
        e2e.FIRECLANKER_E2E_REPOSITORY,
        "Read E2E_MARKER.txt. Do not modify any files. Include the file's exact contents in your final response."
      ], environment, agentRunTimeoutMs)

      expect(output).toMatch(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
      )
      expect(output).toContain("[lambda] worker claimed job")
      expect(output).toContain("[lambda] agent microvm is running")
      expect(output).toContain("[microvm] Source Repository checkout completed")
      expect(output).toContain("[lambda] agent chose not to publish")
      expect(output).toContain("[lambda] job finished")
      expect(output).toContain(e2e.FIRECLANKER_E2E_MARKER)
    } finally {
      await rm(configHome, { recursive: true, force: true })
    }
  },
  { timeout: deploymentTimeoutMs + agentRunTimeoutMs + 60_000 }
)
