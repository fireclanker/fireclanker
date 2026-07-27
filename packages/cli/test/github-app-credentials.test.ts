import { expect, test } from "bun:test"
import {
  GetParameterCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
  type SSMServiceException
} from "@aws-sdk/client-ssm"
import { GitHub } from "@fireclanker/core"
import { Effect, Redacted } from "effect"
import {
  ensureGitHubAppCredentials,
  githubAppParameterName,
  readGitHubAppCredentials,
  type GitHubAppSsmClient
} from "../src/infra/github-app-credentials.ts"

const config = {
  name: "fireclanker-prod",
  region: "us-east-1",
  awsProfile: "sandbox",
  githubOrganization: "acme"
}
const privateKey = "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----"

test("creates and stores GitHub App credentials when the parameter is absent", async () => {
  const commands: Array<GetParameterCommand | PutParameterCommand> = []
  const client: GitHubAppSsmClient = {
    send: async (command) => {
      commands.push(command)
      if (command instanceof GetParameterCommand) {
        throw new ParameterNotFound({ message: "missing", $metadata: {} })
      }
      return { Version: 1, $metadata: {} }
    }
  }
  let createCount = 0

  const result = await Effect.runPromise(ensureGitHubAppCredentials(config, {
    client,
    createApp: () => {
      createCount++
      return Effect.succeed({
        appId: 12345,
        organization: "acme",
        slug: "fireclanker-acme",
        privateKey: Redacted.make(privateKey)
      })
    }
  }))

  expect(result).toEqual({
    created: true,
    installationUrl: "https://github.com/apps/fireclanker-acme/installations/new",
    parameterName: "/fireclanker/fireclanker-prod/github-app"
  })
  expect(createCount).toBe(1)
  expect(commands).toHaveLength(3)
  const pending = commands[1]
  expect(pending).toBeInstanceOf(PutParameterCommand)
  if (!(pending instanceof PutParameterCommand)) throw new Error("Expected PutParameterCommand")
  expect(pending.input).toMatchObject({
    Name: "/fireclanker/fireclanker-prod/github-app",
    Type: "SecureString",
    Tier: "Standard",
    Overwrite: false
  })
  expect(JSON.parse(pending.input.Value ?? "")).toEqual({
    version: 1,
    status: "pending",
    organization: "acme"
  })
  const ready = commands[2]
  expect(ready).toBeInstanceOf(PutParameterCommand)
  if (!(ready instanceof PutParameterCommand)) throw new Error("Expected PutParameterCommand")
  expect(ready.input).toMatchObject({
    Name: "/fireclanker/fireclanker-prod/github-app",
    Type: "SecureString",
    Tier: "Standard",
    Overwrite: true
  })
  expect(JSON.parse(ready.input.Value ?? "")).toEqual({
    version: 1,
    status: "ready",
    organization: "acme",
    appId: 12345,
    slug: "fireclanker-acme",
    privateKey
  })
})

test("reuses existing GitHub App credentials", async () => {
  const client: GitHubAppSsmClient = {
    send: async (command) => {
      if (command instanceof GetParameterCommand) {
        return {
          Parameter: {
            Name: githubAppParameterName(config.name),
            Type: "SecureString",
            Value: JSON.stringify({
              version: 1,
              status: "ready",
              organization: "acme",
              appId: 12345,
              slug: "fireclanker-acme",
              privateKey
            })
          },
          $metadata: {}
        }
      }
      throw new Error("PutParameter should not be called") as SSMServiceException
    }
  }

  const result = await Effect.runPromise(ensureGitHubAppCredentials(config, {
    client,
    createApp: () => Effect.die(new Error("GitHub App creation should not be called"))
  }))

  expect(result).toEqual({
    created: false,
    parameterName: "/fireclanker/fireclanker-prod/github-app"
  })
})

test("reads ready GitHub App credentials for the queue worker", async () => {
  let observed: GetParameterCommand | undefined
  const client: GitHubAppSsmClient = {
    send: async (command) => {
      if (!(command instanceof GetParameterCommand)) {
        throw new Error("PutParameter should not be called") as SSMServiceException
      }
      observed = command
      return {
        Parameter: {
          Name: githubAppParameterName(config.name),
          Type: "SecureString",
          Value: JSON.stringify({
            version: 1,
            status: "ready",
            organization: "acme",
            appId: 12345,
            slug: "fireclanker-acme",
            privateKey
          })
        },
        $metadata: {}
      }
    }
  }

  const credentials = await Effect.runPromise(readGitHubAppCredentials(config.name, { client }))

  expect(observed?.input).toEqual({
    Name: "/fireclanker/fireclanker-prod/github-app",
    WithDecryption: true
  })
  expect(credentials).toMatchObject({
    appId: 12345,
    organization: "acme",
    slug: "fireclanker-acme"
  })
  expect(String(credentials.privateKey)).not.toContain("BEGIN RSA PRIVATE KEY")
  expect(Redacted.value(credentials.privateKey)).toBe(privateKey)
})

test("rejects a pending GitHub App registration", async () => {
  const client: GitHubAppSsmClient = {
    send: async (command) => {
      if (command instanceof GetParameterCommand) {
        return {
          Parameter: {
            Name: githubAppParameterName(config.name),
            Type: "SecureString",
            Value: JSON.stringify({
              version: 1,
              status: "pending",
              organization: "acme"
            })
          },
          $metadata: {}
        }
      }
      throw new Error("PutParameter should not be called") as SSMServiceException
    }
  }

  await expect(Effect.runPromise(ensureGitHubAppCredentials(config, { client })))
    .rejects.toThrow("registration is pending")
})

test("rejects credentials owned by another GitHub organization", async () => {
  const client: GitHubAppSsmClient = {
    send: async (command) => {
      if (command instanceof GetParameterCommand) {
        return {
          Parameter: {
            Name: githubAppParameterName(config.name),
            Type: "SecureString",
            Value: JSON.stringify({
              version: 1,
              status: "ready",
              organization: "other-org",
              appId: 12345,
              slug: "fireclanker-other",
              privateKey
            })
          },
          $metadata: {}
        }
      }
      throw new Error("PutParameter should not be called") as SSMServiceException
    }
  }

  await expect(Effect.runPromise(ensureGitHubAppCredentials(config, { client })))
    .rejects.toThrow("belongs to 'other-org'")
})

test("does not create an App when another deploy wins the registration lock", async () => {
  const client: GitHubAppSsmClient = {
    send: async (command) => {
      if (command instanceof GetParameterCommand) {
        throw new ParameterNotFound({ message: "missing", $metadata: {} })
      }
      throw new ParameterAlreadyExists({ message: "exists", $metadata: {} })
    }
  }
  let createCount = 0

  await expect(Effect.runPromise(ensureGitHubAppCredentials(config, {
    client,
    createApp: () => {
      createCount++
      return Effect.die(new Error("GitHub App creation should not be called"))
    }
  }))).rejects.toThrow("Another deployment is registering")
  expect(createCount).toBe(0)
})

test("leaves the pending lock when GitHub registration fails", async () => {
  const commands: Array<GetParameterCommand | PutParameterCommand> = []
  const client: GitHubAppSsmClient = {
    send: async (command) => {
      commands.push(command)
      if (command instanceof GetParameterCommand) {
        throw new ParameterNotFound({ message: "missing", $metadata: {} })
      }
      return { Version: 1, $metadata: {} }
    }
  }

  await expect(Effect.runPromise(ensureGitHubAppCredentials(config, {
    client,
    createApp: () => Effect.fail(new GitHub.GitHubAppCreationError({
      operation: "exchange-manifest"
    }))
  }))).rejects.toThrow("pending parameter")
  expect(commands).toHaveLength(2)
  expect(commands[1]).toBeInstanceOf(PutParameterCommand)
  if (!(commands[1] instanceof PutParameterCommand)) throw new Error("Expected PutParameterCommand")
  expect(commands[1].input.Overwrite).toBe(false)
})
