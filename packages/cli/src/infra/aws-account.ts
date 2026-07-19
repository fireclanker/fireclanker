import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts"
import { Effect } from "effect"

export const ensureAwsAccountId = Effect.gen(function*() {
  if (process.env.AWS_ACCOUNT_ID) {
    return
  }

  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new STSClient()),
    (client) => Effect.sync(() => client.destroy())
  )
  const response = yield* Effect.tryPromise({
    try: () => client.send(new GetCallerIdentityCommand()),
    catch: (cause) => new Error("Unable to resolve the active AWS account ID", {
      cause
    })
  })

  if (!response.Account) {
    return yield* Effect.fail(
      new Error("AWS STS did not return an account ID")
    )
  }

  process.env.AWS_ACCOUNT_ID = response.Account
})
