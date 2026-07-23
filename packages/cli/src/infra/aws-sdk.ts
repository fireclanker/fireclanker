import { fromIni } from "@aws-sdk/credential-providers"
import { STS } from "@effect-aws/client-sts"
import {
  CredentialsStore,
  credentialsFilePath
} from "alchemy/Auth/Credentials"
import { AlchemyProfile } from "alchemy/Auth/Profile"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import type { FireclankerConfig } from "../config.ts"

const alchemyProfile = "fireclanker"

export const configureAwsSdk = (config: FireclankerConfig) => Effect.gen(function*() {
  const awsProfile = config.awsProfile
  const credentialProvider = fromIni({ profile: awsProfile })
  const credentials = yield* Effect.tryPromise({
    try: () => credentialProvider(),
    catch: (cause) => new Error(
      `Unable to resolve AWS profile '${awsProfile}'. Ensure the profile exists and its credentials are current. For SSO profiles, run 'aws sso login --profile ${awsProfile}'.`,
      { cause }
    )
  })

  const identity = yield* STS.use((service) =>
    service.getCallerIdentity({})
  ).pipe(
    Effect.provide(STS.layer({
      region: config.region,
      credentials
    })),
    Effect.mapError((cause) => new Error(
      `Unable to verify the AWS identity for profile '${awsProfile}'`,
      { cause }
    ))
  )
  if (!identity.Account) {
    return yield* Effect.fail(
      new Error(`AWS STS did not return an account for profile '${awsProfile}'`)
    )
  }

  const store = yield* CredentialsStore
  yield* store.write(alchemyProfile, "aws", {
    accountId: identity.Account,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region: config.region
  })

  const fs = yield* FileSystem.FileSystem
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
      credentials: credentialProvider,
      region: config.region
    }
  }
})
