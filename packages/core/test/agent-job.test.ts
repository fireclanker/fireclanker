import type { PutItemCommandInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  type AgentJobDynamoClient,
  AgentJobService,
  AgentJobServiceLive,
  DynamoAgentJobRepository
} from "../src/agent-job/index.ts"

const makeClient = () => {
  const writes: Array<PutItemCommandInput> = []
  const client: AgentJobDynamoClient = {
    send: (command) => {
      writes.push(command.input)
      return Promise.resolve({ $metadata: {} })
    }
  }

  return { client, writes }
}

describe("AgentJobService.queueJob", () => {
  test("persists and returns a queued job", async () => {
    const { client, writes } = makeClient()
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )
    const job = await Effect.runPromise(
      Effect.gen(function*() {
        const agentJob = yield* AgentJobService
        return yield* agentJob.queueJob("  investigate the failure  ")
      }).pipe(
        Effect.provide(layer)
      )
    )

    expect(job.status).toBe("queued")
    expect(String(job.prompt)).toBe("  investigate the failure  ")
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      TableName: "fireclanker",
      Item: {
        PK: { S: `RUN#${job.id}` },
        SK: { S: "RUN" },
        entityType: { S: "AgentRun" },
        id: { S: job.id },
        prompt: { S: job.prompt },
        status: { S: "queued" },
        createdAt: { S: expect.any(String) },
        createdAtId: { S: expect.stringMatching(new RegExp(`#${job.id}$`)) }
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    })
  })

  test("rejects a whitespace-only prompt without writing", async () => {
    const { client, writes } = makeClient()
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const agentJob = yield* AgentJobService
        return yield* agentJob.queueJob(" \n\t ").pipe(Effect.flip)
      }).pipe(
        Effect.provide(layer)
      )
    )

    expect(error._tag).toBe("InvalidAgentPrompt")
    expect(writes).toHaveLength(0)
  })
})
