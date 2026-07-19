import { expect, test } from "bun:test"

test("lists the destroy command", async () => {
  const process = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe"
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(stdout).toContain("destroy    Destroy Fireclanker infrastructure in AWS")
})

test("requires explicit approval to destroy infrastructure", async () => {
  const process = Bun.spawn(["bun", "run", "src/index.ts", "destroy", "--help"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe"
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(stdout).toContain("--yes")
  expect(stdout).toContain("Skip the destruction confirmation")
})
