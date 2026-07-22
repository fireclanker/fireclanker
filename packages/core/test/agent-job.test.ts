import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type PutItemCommandInput
} from "@aws-sdk/client-dynamodb"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import {
  type AgentJobDynamoClient,
  AgentJobId,
  AgentJobRepository,
  AgentJobService,
  AgentJobServiceLive,
  DynamoAgentJobRepository
} from "../src/agent-job/index.ts"

const makeClient = () => {
  const writes: Array<PutItemCommandInput> = []
  const client: AgentJobDynamoClient = {
    send: (command) => {
      if (command instanceof PutItemCommand) writes.push(command.input)
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

  test("persists the Target Repository binding for a repo-bound run", async () => {
    const { client, writes } = makeClient()
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )
    const job = await Effect.runPromise(
      Effect.gen(function*() {
        const agentJob = yield* AgentJobService
        return yield* agentJob.queueJob("fix the flaky login test", "owner/name")
      }).pipe(
        Effect.provide(layer)
      )
    )

    expect(job.status).toBe("queued")
    expect(String(job.targetRepository)).toBe("owner/name")
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
        createdAtId: { S: expect.stringMatching(new RegExp(`#${job.id}$`)) },
        targetRepository: { S: "owner/name" }
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    })
  })

  test.each([
    "https://github.com/owner/name",
    "https://github.com/owner/name.git",
    "https://github.com/owner/name/"
  ])("normalizes %s to the owner/name binding", async (input) => {
    const { client, writes } = makeClient()
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )
    const job = await Effect.runPromise(
      Effect.gen(function*() {
        const agentJob = yield* AgentJobService
        return yield* agentJob.queueJob("fix the flaky login test", input)
      }).pipe(
        Effect.provide(layer)
      )
    )

    expect(String(job.targetRepository)).toBe("owner/name")
    expect(writes).toHaveLength(1)
    expect(writes[0]?.Item?.targetRepository).toEqual({ S: "owner/name" })
  })

  test.each([
    "name",
    "owner/",
    "owner//name",
    "owner/name/extra",
    "http://github.com/owner/name",
    "git@github.com:owner/name.git",
    "https://github.com/owner",
    "https://gitlab.com/owner/name",
    "-owner/name",
    "owner/.",
    "owner name/repo"
  ])("rejects malformed Target Repository %s without writing", async (input) => {
    const { client, writes } = makeClient()
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const agentJob = yield* AgentJobService
        return yield* agentJob.queueJob("fix the flaky login test", input).pipe(Effect.flip)
      }).pipe(
        Effect.provide(layer)
      )
    )

    expect(error._tag).toBe("InvalidTargetRepository")
    expect(writes).toHaveLength(0)
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

describe("AgentJob lifecycle", () => {
  test("aliases terminal attribute names in update expressions", async () => {
    const client: AgentJobDynamoClient = {
      send: async (command) => {
        expect(command).toBeInstanceOf(UpdateItemCommand)
        if (!(command instanceof UpdateItemCommand)) throw new Error("unexpected command")
        expect(command.input.UpdateExpression).toBe(
          "SET #status = :status, completedAt = :completedAt, #terminalValue = :value"
        )
        expect(command.input.ExpressionAttributeNames).toEqual({
          "#status": "status",
          "#terminalValue": "result"
        })
        return { $metadata: {} }
      }
    }
    const id = Schema.decodeUnknownSync(AgentJobId)(crypto.randomUUID())

    await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* AgentJobRepository
        yield* repository.succeed(id, "echo: hello", "2026-07-19T20:49:58.000Z")
      }).pipe(
        Effect.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client })),
        Effect.scoped
      )
    )
  })

  test("only claims a queued job once", async () => {
    let calls = 0
    const client: AgentJobDynamoClient = {
      send: async (command) => {
        expect(command).toBeInstanceOf(UpdateItemCommand)
        calls++
        if (calls === 2) {
          throw new ConditionalCheckFailedException({
            $metadata: {},
            message: "already claimed"
          })
        }
        return { $metadata: {} }
      }
    }
    const id = Schema.decodeUnknownSync(AgentJobId)(crypto.randomUUID())
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )

    const claims = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* AgentJobService
        return [yield* service.claim(id), yield* service.claim(id)]
      }).pipe(Effect.provide(layer), Effect.scoped)
    )

    expect(claims).toEqual([true, false])
  })

  test("decodes the Target Repository binding through get", async () => {
    const boundId = crypto.randomUUID()
    const plainId = crypto.randomUUID()
    const now = "2026-07-19T12:00:00.000Z"
    const queuedItem = (id: string) => ({
      PK: { S: `RUN#${id}` },
      SK: { S: "RUN" },
      id: { S: id },
      prompt: { S: "hello" },
      status: { S: "queued" },
      createdAt: { S: now }
    })
    const client: AgentJobDynamoClient = {
      send: async (command) => {
        expect(command).toBeInstanceOf(GetItemCommand)
        if (!(command instanceof GetItemCommand)) throw new Error("unexpected command")
        return command.input.Key?.PK?.S === `RUN#${boundId}`
          ? {
            $metadata: {},
            Item: { ...queuedItem(boundId), targetRepository: { S: "owner/name" } }
          }
          : { $metadata: {}, Item: queuedItem(plainId) }
      }
    }
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* AgentJobService
        return {
          bound: yield* service.get(Schema.decodeUnknownSync(AgentJobId)(boundId)),
          plain: yield* service.get(Schema.decodeUnknownSync(AgentJobId)(plainId))
        }
      }).pipe(Effect.provide(layer), Effect.scoped)
    )

    expect(String(result.bound.targetRepository)).toBe("owner/name")
    expect(result.plain.targetRepository).toBeUndefined()
  })

  test("decodes terminal jobs and ordered events", async () => {
    const id = crypto.randomUUID()
    const now = "2026-07-19T12:00:00.000Z"
    let queryCalls = 0
    const client: AgentJobDynamoClient = {
      send: async (command) => {
        if (command instanceof GetItemCommand) {
          return {
            $metadata: {},
            Item: {
              PK: { S: `RUN#${id}` },
              SK: { S: "RUN" },
              id: { S: id },
              prompt: { S: "hello" },
              status: { S: "succeeded" },
              createdAt: { S: now },
              startedAt: { S: now },
              completedAt: { S: now },
              result: { S: "echo: hello" }
            }
          }
        }
        if (command instanceof QueryCommand) {
          queryCalls++
          expect(command.input.KeyConditionExpression).toBe(
            "PK = :pk AND SK BETWEEN :start AND :end"
          )
          expect(command.input.ExpressionAttributeValues?.[":start"]).toEqual({
            S: "EVENT#000000000001"
          })
          const sequence = queryCalls
          return {
            $metadata: {},
            Items: [{
              PK: { S: `RUN#${id}` },
              SK: { S: `EVENT#${String(sequence).padStart(12, "0")}` },
              jobId: { S: id },
              sequence: { N: String(sequence) },
              message: { S: `event ${sequence}` },
              createdAt: { S: now }
            }],
            LastEvaluatedKey: queryCalls === 1
              ? { PK: { S: `RUN#${id}` }, SK: { S: "EVENT#000000000001" } }
              : undefined
          }
        }
        throw new Error("unexpected command")
      }
    }
    const jobId = Schema.decodeUnknownSync(AgentJobId)(id)
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* AgentJobService
        return {
          job: yield* service.get(jobId),
          events: yield* service.listEventsAfter(jobId, 0)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)
    )

    expect(result.job.status).toBe("succeeded")
    expect(result.events.map((event) => event.message)).toEqual(["event 1", "event 2"])
    expect(queryCalls).toBe(2)
  })
})
