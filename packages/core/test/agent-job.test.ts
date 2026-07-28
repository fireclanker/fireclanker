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
  DynamoAgentJobRepository,
  parseSourceRepositoryArgument,
  SourceRepositoryArgument
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
        return yield* agentJob.queueJob({
          prompt: "  investigate the failure  ",
          sourceRepository: "Fireclanker/example.repo",
          sourceBranch: "feature/explicit-start"
        })
      }).pipe(
        Effect.provide(layer)
      )
    )

    expect(job.status).toBe("queued")
    expect(String(job.prompt)).toBe("  investigate the failure  ")
    expect(String(job.sourceRepository)).toBe("Fireclanker/example.repo")
    expect(String(job.sourceBranch)).toBe("feature/explicit-start")
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      TableName: "fireclanker",
      Item: {
        PK: { S: `RUN#${job.id}` },
        SK: { S: "RUN" },
        entityType: { S: "AgentRun" },
        id: { S: job.id },
        prompt: { S: job.prompt },
        sourceRepository: { S: "Fireclanker/example.repo" },
        sourceBranch: { S: "feature/explicit-start" },
        status: { S: "queued" },
        createdAt: { S: expect.any(String) },
        createdAtId: { S: expect.stringMatching(new RegExp(`#${job.id}$`)) }
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    })
  })

  test("parses an explicit Source Branch separately from the Source Repository", () => {
    const input = Schema.decodeUnknownSync(SourceRepositoryArgument)(
      "fireclanker/fireclanker@feature/branch@v2"
    )

    const parsed = parseSourceRepositoryArgument(input)
    expect(String(parsed.sourceRepository)).toBe("fireclanker/fireclanker")
    expect(String(parsed.sourceBranch)).toBe("feature/branch@v2")
  })

  test("rejects a whitespace-only prompt without writing", async () => {
    const { client, writes } = makeClient()
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const agentJob = yield* AgentJobService
        return yield* agentJob.queueJob({
          prompt: " \n\t ",
          sourceRepository: "fireclanker/example"
        }).pipe(Effect.flip)
      }).pipe(
        Effect.provide(layer)
      )
    )

    expect(error._tag).toBe("InvalidAgentPrompt")
    expect(writes).toHaveLength(0)
  })

  for (const sourceRepository of [
    "https://github.com/fireclanker/example",
    "fire--clanker/example"
  ]) {
    test(`rejects non-canonical Source Repository ${sourceRepository}`, async () => {
      const { client, writes } = makeClient()
      const layer = AgentJobServiceLive.pipe(
        Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
      )
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const agentJob = yield* AgentJobService
          return yield* agentJob.queueJob({
            prompt: "investigate",
            sourceRepository
          }).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer)
        )
      )

      expect(error._tag).toBe("InvalidSourceRepository")
      expect(writes).toHaveLength(0)
    })
  }

  for (const sourceBranch of [
    "",
    "-dangerous",
    "feature//nested",
    "feature with spaces",
    "feature.lock"
  ]) {
    test(`rejects invalid Source Branch ${JSON.stringify(sourceBranch)}`, async () => {
      const { client, writes } = makeClient()
      const layer = AgentJobServiceLive.pipe(
        Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
      )
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const agentJob = yield* AgentJobService
          return yield* agentJob.queueJob({
            prompt: "investigate",
            sourceRepository: "fireclanker/example",
            sourceBranch
          }).pipe(Effect.flip)
        }).pipe(Effect.provide(layer))
      )

      expect(error._tag).toBe("InvalidSourceBranch")
      expect(writes).toHaveLength(0)
    })
  }
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
              sourceRepository: { S: "fireclanker/example" },
              sourceBranch: { S: "release/next" },
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
    expect(String(result.job.sourceRepository)).toBe("fireclanker/example")
    expect(String(result.job.sourceBranch)).toBe("release/next")
    expect(result.events.map((event) => event.message)).toEqual(["event 1", "event 2"])
    expect(queryCalls).toBe(2)
  })

  test("decodes historical jobs without a Source Repository", async () => {
    const id = crypto.randomUUID()
    const client: AgentJobDynamoClient = {
      send: async (command) => {
        expect(command).toBeInstanceOf(GetItemCommand)
        return {
          $metadata: {},
          Item: {
            id: { S: id },
            prompt: { S: "hello" },
            status: { S: "queued" },
            createdAt: { S: "2026-07-19T12:00:00.000Z" }
          }
        }
      }
    }
    const jobId = Schema.decodeUnknownSync(AgentJobId)(id)
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )

    const job = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* AgentJobService
        return yield* service.get(jobId)
      }).pipe(Effect.provide(layer), Effect.scoped)
    )

    expect(job.status).toBe("queued")
    expect(job.sourceRepository).toBeUndefined()
  })

  test("rejects malformed persisted Source Repository data", async () => {
    const id = crypto.randomUUID()
    const client: AgentJobDynamoClient = {
      send: async () => ({
        $metadata: {},
        Item: {
          id: { S: id },
          prompt: { S: "hello" },
          sourceRepository: { S: "https://github.com/fireclanker/example" },
          status: { S: "queued" },
          createdAt: { S: "2026-07-19T12:00:00.000Z" }
        }
      })
    }
    const jobId = Schema.decodeUnknownSync(AgentJobId)(id)
    const layer = AgentJobServiceLive.pipe(
      Layer.provide(DynamoAgentJobRepository({ tableName: "fireclanker", client }))
    )

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* AgentJobService
        return yield* service.get(jobId).pipe(Effect.flip)
      }).pipe(Effect.provide(layer), Effect.scoped)
    )

    expect(error._tag).toBe("AgentJobOperationError")
  })
})
