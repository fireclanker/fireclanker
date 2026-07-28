import { afterEach, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand
} from "@aws-sdk/client-ssm"
import { Effect, Redacted } from "effect"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  openAISubscriptionParameterName,
  readLocalOpenAISubscriptionCredential,
  refreshOpenAISubscriptionAccess,
  storeOpenAISubscriptionCredential,
  type OpenAISubscriptionCredential,
  type OpenAISubscriptionSsmClient
} from "../src/infra/openai-subscription.ts"

const deploymentName = "fireclanker-prod"
const credential: OpenAISubscriptionCredential = {
  type: "oauth",
  refresh: "refresh-old",
  access: "access-old",
  expires: 1_900_000_000_000,
  accountId: "account-123"
}
const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

test("stores only the OpenAI OAuth credential in a SecureString", async () => {
  let observed: PutParameterCommand | undefined
  const client: OpenAISubscriptionSsmClient = {
    send: async (command) => {
      if (!(command instanceof PutParameterCommand)) {
        throw new Error("GetParameter should not be called")
      }
      observed = command
      return { Version: 1, $metadata: {} }
    }
  }

  const parameterName = await Effect.runPromise(
    storeOpenAISubscriptionCredential(deploymentName, credential, { client })
  )

  expect(parameterName).toBe(
    "/fireclanker/fireclanker-prod/openai-subscription"
  )
  expect(observed?.input).toMatchObject({
    Name: parameterName,
    Type: "SecureString",
    Tier: "Standard",
    Overwrite: true
  })
  expect(JSON.parse(observed?.input.Value ?? "")).toEqual({
    version: 1,
    credential
  })
})

test("refreshes and rotates the credential before returning short-lived access", async () => {
  const commands: Array<GetParameterCommand | PutParameterCommand> = []
  const client: OpenAISubscriptionSsmClient = {
    send: async (command) => {
      commands.push(command)
      if (command instanceof GetParameterCommand) {
        return {
          Parameter: {
            Name: openAISubscriptionParameterName(deploymentName),
            Type: "SecureString",
            Value: JSON.stringify({ version: 1, credential })
          },
          $metadata: {}
        }
      }
      return { Version: 2, $metadata: {} }
    }
  }
  let requestBody = ""
  const fetch = (async (
    _input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1]
  ) => {
    requestBody = String(init?.body)
    return new Response(JSON.stringify({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  }) as unknown as typeof globalThis.fetch

  const access = await Effect.runPromise(refreshOpenAISubscriptionAccess(
    deploymentName,
    {
      client,
      fetch,
      now: () => 2_000_000_000_000
    }
  ))

  expect(requestBody).toContain("grant_type=refresh_token")
  expect(requestBody).toContain("refresh_token=refresh-old")
  expect(access).toMatchObject({
    expiresAt: 2_000_003_600_000,
    accountId: "account-123"
  })
  expect(String(access?.accessToken)).not.toContain("access-new")
  expect(Redacted.value(access!.accessToken)).toBe("access-new")
  expect(commands).toHaveLength(2)
  const put = commands[1]
  expect(put).toBeInstanceOf(PutParameterCommand)
  if (!(put instanceof PutParameterCommand)) {
    throw new Error("Expected PutParameterCommand")
  }
  expect(JSON.parse(put.input.Value ?? "")).toEqual({
    version: 1,
    credential: {
      type: "oauth",
      refresh: "refresh-new",
      access: "access-new",
      expires: 2_000_003_600_000,
      accountId: "account-123"
    }
  })
})

test("uses OpenCode's one-hour lifetime when refresh omits expires_in", async () => {
  const client: OpenAISubscriptionSsmClient = {
    send: async (command) => {
      if (command instanceof GetParameterCommand) {
        return {
          Parameter: {
            Name: openAISubscriptionParameterName(deploymentName),
            Type: "SecureString",
            Value: JSON.stringify({ version: 1, credential })
          },
          $metadata: {}
        }
      }
      return { Version: 2, $metadata: {} }
    }
  }
  const fetch = (async () => new Response(JSON.stringify({
    access_token: "access-new",
    refresh_token: "refresh-new"
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })) as unknown as typeof globalThis.fetch

  const access = await Effect.runPromise(refreshOpenAISubscriptionAccess(
    deploymentName,
    {
      client,
      fetch,
      now: () => 2_000_000_000_000
    }
  ))

  expect(access?.expiresAt).toBe(2_000_003_600_000)
})

test("falls back to Bedrock when no subscription parameter exists", async () => {
  const client: OpenAISubscriptionSsmClient = {
    send: async (command) => {
      if (command instanceof GetParameterCommand) {
        throw new ParameterNotFound({ message: "missing", $metadata: {} })
      }
      throw new Error("PutParameter should not be called")
    }
  }
  let fetched = false

  const access = await Effect.runPromise(refreshOpenAISubscriptionAccess(
    deploymentName,
    {
      client,
      fetch: (async () => {
        fetched = true
        throw new Error("fetch should not be called")
      }) as unknown as typeof globalThis.fetch
    }
  ))

  expect(access).toBeUndefined()
  expect(fetched).toBe(false)
})

test("reads the local OpenCode ChatGPT OAuth credential", async () => {
  const home = await mkdtemp(join(tmpdir(), "fireclanker-openai-test-"))
  temporaryDirectories.push(home)
  const authDirectory = join(home, ".local", "share", "opencode")
  await mkdir(authDirectory, { recursive: true })
  await writeFile(join(authDirectory, "auth.json"), JSON.stringify({
    openai: credential,
    unrelated: { type: "api", key: "other-secret" }
  }))
  const previousHome = process.env.HOME
  const previousDataHome = process.env.XDG_DATA_HOME
  process.env.HOME = home
  delete process.env.XDG_DATA_HOME

  try {
    const result = await Effect.runPromise(
      readLocalOpenAISubscriptionCredential.pipe(
        Effect.provide(BunServices.layer)
      )
    )
    expect(result).toEqual(credential)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
  }
})
