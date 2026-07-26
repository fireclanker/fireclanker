import { expect, test } from "bun:test"
import { ParseError } from "@distilled.cloud/aws/Errors"
import { Effect } from "effect"
import { retryTransientAwsGatewayErrors } from "../src/infra/deploy.ts"

test("retries a transient AWS HTML gateway response", async () => {
  let attempts = 0
  const operation = Effect.suspend(() => {
    attempts++
    return attempts === 1
      ? Effect.fail(new ParseError({
        message: "Failed to parse error JSON body: <html><h1>502 Bad Gateway</h1></html>"
      }))
      : Effect.succeed("updated")
  })

  expect(await Effect.runPromise(retryTransientAwsGatewayErrors(operation))).toBe("updated")
  expect(attempts).toBe(2)
})

test("does not retry other parse errors", async () => {
  let attempts = 0
  const operation = Effect.suspend(() => {
    attempts++
    return Effect.fail(new ParseError({ message: "Invalid response schema" }))
  })

  await expect(Effect.runPromise(retryTransientAwsGatewayErrors(operation)))
    .rejects.toThrow("Invalid response schema")
  expect(attempts).toBe(1)
})
