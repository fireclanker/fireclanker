import {
  GetRoleCredentialsCommand,
  SSOClient
} from "@aws-sdk/client-sso"
import {
  AuthorizationPendingException,
  CreateTokenCommand,
  RegisterClientCommand,
  SlowDownException,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand
} from "@aws-sdk/client-sso-oidc"
import { STS } from "@effect-aws/client-sts"
import {
  CredentialsStore,
  credentialsFilePath
} from "alchemy/Auth/Credentials"
import { AlchemyProfile, rootDir } from "alchemy/Auth/Profile"
import { Effect, Schedule } from "effect"
import * as Console from "effect/Console"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import open from "open"

const alchemyProfile = "fireclanker"
const ssoStartUrl = "https://d-99677e3a34.awsapps.com/start"
const ssoRegion = "eu-central-1"
const awsAccountId = "021891617269"
const awsRoleName = "AdministratorAccess"
const awsRegion = "us-east-1"

export const configureAwsSdk = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tokenPath = path.join(
    rootDir,
    "credentials",
    alchemyProfile,
    "sso-token.json"
  )

  const cachedToken = yield* fs.readFileString(tokenPath).pipe(
    Effect.flatMap((contents) => Effect.try({
      try: () => JSON.parse(contents) as {
        readonly accessToken?: unknown
        readonly expiresAt?: unknown
      },
      catch: () => undefined
    })),
    Effect.map((token) =>
      token !== undefined &&
        typeof token.accessToken === "string" &&
        typeof token.expiresAt === "number" &&
        token.expiresAt > Date.now() + 60_000
        ? token.accessToken
        : undefined
    ),
    Effect.catch(() => Effect.succeed(undefined))
  )

  const oidc = yield* Effect.acquireRelease(
    Effect.sync(() => new SSOOIDCClient({ region: ssoRegion })),
    (client) => Effect.sync(() => client.destroy())
  )
  const sso = yield* Effect.acquireRelease(
    Effect.sync(() => new SSOClient({ region: ssoRegion })),
    (client) => Effect.sync(() => client.destroy())
  )

  const authorize = Effect.gen(function*() {
    const registration = yield* Effect.tryPromise({
      try: () => oidc.send(new RegisterClientCommand({
        clientName: "fireclanker",
        clientType: "public",
        scopes: ["sso:account:access"]
      })),
      catch: (cause) => new Error("Unable to register the AWS SSO client", { cause })
    })
    if (!registration.clientId || !registration.clientSecret) {
      return yield* Effect.fail(
        new Error("AWS SSO client registration returned incomplete credentials")
      )
    }

    const authorization = yield* Effect.tryPromise({
      try: () => oidc.send(new StartDeviceAuthorizationCommand({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        startUrl: ssoStartUrl
      })),
      catch: (cause) => new Error("Unable to start AWS SSO authorization", { cause })
    })
    if (!authorization.deviceCode || !authorization.verificationUri) {
      return yield* Effect.fail(
        new Error("AWS SSO authorization returned an incomplete device challenge")
      )
    }

    const verificationUrl = authorization.verificationUriComplete ?? authorization.verificationUri
    yield* Console.log(
      `Complete AWS sign-in at ${verificationUrl}` +
        (authorization.userCode ? ` using code ${authorization.userCode}` : "")
    )
    yield* Effect.tryPromise({
      try: () => open(verificationUrl),
      catch: () => undefined
    }).pipe(Effect.catch(() => Effect.void))

    const token = yield* Effect.tryPromise({
      try: () => oidc.send(new CreateTokenCommand({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        deviceCode: authorization.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code"
      })),
      catch: (cause) => cause
    }).pipe(
      Effect.retry({
        while: (error) =>
          error instanceof AuthorizationPendingException ||
          error instanceof SlowDownException,
        schedule: Schedule.spaced(`${Math.max(authorization.interval ?? 5, 5)} seconds`)
      }),
      Effect.timeout(`${authorization.expiresIn ?? 600} seconds`),
      Effect.mapError((cause) => new Error("AWS SSO authorization failed", { cause }))
    )
    if (!token.accessToken || !token.expiresIn) {
      return yield* Effect.fail(
        new Error("AWS SSO authorization returned an incomplete token")
      )
    }

    yield* fs.makeDirectory(path.dirname(tokenPath), { recursive: true })
    yield* fs.writeFileString(tokenPath, JSON.stringify({
      accessToken: token.accessToken,
      expiresAt: Date.now() + token.expiresIn * 1_000
    }))
    yield* fs.chmod(tokenPath, 0o600)

    return token.accessToken
  })

  const getRoleCredentials = (accessToken: string) => Effect.tryPromise({
    try: () => sso.send(new GetRoleCredentialsCommand({
      accessToken,
      accountId: awsAccountId,
      roleName: awsRoleName
    })),
    catch: (cause) => new Error("Unable to resolve AWS role credentials", { cause })
  }).pipe(
    Effect.flatMap(({ roleCredentials }) =>
      roleCredentials?.accessKeyId &&
        roleCredentials.secretAccessKey &&
        roleCredentials.sessionToken
        ? Effect.succeed({
          accessKeyId: roleCredentials.accessKeyId,
          secretAccessKey: roleCredentials.secretAccessKey,
          sessionToken: roleCredentials.sessionToken
        })
        : Effect.fail(new Error("AWS SSO returned incomplete role credentials"))
    )
  )

  const credentials = cachedToken
    ? yield* getRoleCredentials(cachedToken).pipe(
      Effect.catch(() => authorize.pipe(Effect.flatMap(getRoleCredentials)))
    )
    : yield* authorize.pipe(Effect.flatMap(getRoleCredentials))

  const identity = yield* STS.use((service) =>
    service.getCallerIdentity({})
  ).pipe(
    Effect.provide(STS.layer({
      region: awsRegion,
      credentials
    })),
    Effect.mapError((cause) => new Error("Unable to verify the AWS identity", { cause }))
  )
  if (identity.Account !== awsAccountId) {
    return yield* Effect.fail(
      new Error(`AWS SSO returned account '${identity.Account ?? "unknown"}', expected '${awsAccountId}'`)
    )
  }

  const store = yield* CredentialsStore
  yield* store.write(alchemyProfile, "aws", {
    accountId: awsAccountId,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region: awsRegion
  })
  yield* fs.chmod(credentialsFilePath(alchemyProfile, "aws"), 0o600)

  const profiles = yield* AlchemyProfile
  const profile = yield* profiles.getProfile(alchemyProfile)
  yield* profiles.setProfile(alchemyProfile, {
    ...profile,
    AWS: { method: "stored" }
  })

  return {
    profile: alchemyProfile,
    clientConfig: {
      credentials,
      region: awsRegion
    }
  }
})
