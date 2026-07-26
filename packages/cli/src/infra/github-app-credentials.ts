import {
  GetParameterCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
  type GetParameterCommandOutput,
  type PutParameterCommandOutput,
  type SSMClientConfig
} from "@aws-sdk/client-ssm"
import { GitHub } from "@fireclanker/core"
import { Effect, Redacted, Schema } from "effect"
import type { FireclankerConfig } from "../config.ts"

type GitHubAppSsmCommand = GetParameterCommand | PutParameterCommand
type GitHubAppSsmOutput = GetParameterCommandOutput | PutParameterCommandOutput

export interface GitHubAppSsmClient {
  readonly send: (command: GitHubAppSsmCommand) => Promise<GitHubAppSsmOutput>
  readonly destroy?: () => void
}

export interface EnsureGitHubAppCredentialsOptions {
  readonly client?: GitHubAppSsmClient
  readonly clientConfig?: SSMClientConfig
  readonly createApp?: typeof GitHub.createApp
}

const GitHubAppId = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
)
const GitHubAppSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
)
const GitHubPrivateKey = Schema.String.check(
  Schema.isPattern(/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/)
)

const GitHubAppCredentialsEnvelope = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("pending"),
    organization: Schema.String
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("ready"),
    organization: Schema.String,
    appId: GitHubAppId,
    slug: GitHubAppSlug,
    privateKey: GitHubPrivateKey
  })
])

export const githubAppParameterName = (deploymentName: string): string =>
  `/fireclanker/${deploymentName}/github-app`

export const ensureGitHubAppCredentials = Effect.fn("GitHub.ensureAppCredentials")(
  function*(
    config: FireclankerConfig,
    options: EnsureGitHubAppCredentialsOptions = {}
  ) {
    const ownedClient = options.client === undefined
    const client = options.client ?? (options.clientConfig === undefined
      ? new SSMClient()
      : new SSMClient(options.clientConfig))

    return yield* Effect.gen(function*() {
      const parameterName = githubAppParameterName(config.name)
      const existing = yield* Effect.tryPromise({
        try: () => client.send(new GetParameterCommand({
          Name: parameterName,
          WithDecryption: true
        })),
        catch: (cause) => cause
      }).pipe(
        Effect.catchIf(
          (cause) => cause instanceof ParameterNotFound,
          () => Effect.succeed(undefined)
        ),
        Effect.mapError(() => new Error("Unable to check GitHub App credentials in Parameter Store"))
      )
      if (existing !== undefined) {
        const parameter = existing as GetParameterCommandOutput
        if (parameter.Parameter?.Type !== "SecureString" || parameter.Parameter.Value === undefined) {
          return yield* Effect.fail(new Error("GitHub App credentials parameter is not a SecureString"))
        }
        const envelope = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(GitHubAppCredentialsEnvelope)
        )(parameter.Parameter.Value).pipe(
          Effect.mapError(() => new Error("GitHub App credentials parameter is invalid"))
        )
        if (envelope.organization !== config.githubOrganization) {
          return yield* Effect.fail(new Error(
            `GitHub App belongs to '${envelope.organization}', not '${config.githubOrganization}'`
          ))
        }
        if (envelope.status === "pending") {
          return yield* Effect.fail(new Error(
            `GitHub App registration is pending at ${parameterName}; resolve or remove it before deploying again`
          ))
        }
        return { created: false, parameterName } as const
      }

      yield* Effect.tryPromise({
        try: () => client.send(new PutParameterCommand({
          Name: parameterName,
          Description: "Fireclanker GitHub App credentials",
          Type: "SecureString",
          Tier: "Standard",
          Value: JSON.stringify({
            version: 1,
            status: "pending",
            organization: config.githubOrganization
          }),
          Overwrite: false
        })),
        catch: (cause) => cause
      }).pipe(
        Effect.mapError((cause) => cause instanceof ParameterAlreadyExists
          ? new Error("Another deployment is registering the GitHub App")
          : new Error("Unable to reserve the GitHub App credentials parameter"))
      )

      const createApp = options.createApp ?? GitHub.createApp
      const suffix = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8))
      const app = yield* createApp({
        organization: config.githubOrganization,
        name: `fc-${config.name.slice(0, 20)}-${suffix}`,
        homepageUrl: "https://github.com/fireclanker/fireclanker"
      }).pipe(
        Effect.mapError(() => new Error(
          `GitHub App registration did not complete; the pending parameter at ${parameterName} prevents duplicate creation`
        ))
      )
      if (app.organization.toLowerCase() !== config.githubOrganization.toLowerCase()) {
        return yield* Effect.fail(new Error("GitHub created the App under a different organization"))
      }
      const value = JSON.stringify({
        version: 1,
        status: "ready",
        organization: app.organization,
        appId: app.appId,
        slug: app.slug,
        privateKey: Redacted.value(app.privateKey)
      })
      yield* Effect.tryPromise({
        try: () => client.send(new PutParameterCommand({
          Name: parameterName,
          Description: "Fireclanker GitHub App credentials",
          Type: "SecureString",
          Tier: "Standard",
          Value: value,
          Overwrite: true
        })),
        catch: () => new Error(
          `GitHub App '${app.slug}' was created but its credentials could not replace the pending parameter at ${parameterName}`
        )
      })

      return {
        created: true,
        installationUrl: `https://github.com/apps/${app.slug}/installations/new`,
        parameterName
      } as const
    }).pipe(
      Effect.ensuring(ownedClient
        ? Effect.sync(() => client.destroy?.())
        : Effect.void)
    )
  }
)
