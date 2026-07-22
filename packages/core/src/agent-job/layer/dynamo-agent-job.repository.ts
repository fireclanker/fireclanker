import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClientConfig,
  type GetItemCommandOutput,
  type PutItemCommandOutput,
  type QueryCommandOutput,
  type UpdateItemCommandOutput
} from "@aws-sdk/client-dynamodb"
import { Effect, Layer, Schema } from "effect"
import { AgentJob, AgentJobEvent } from "../agent-job.model.ts"
import { AgentJobRepositoryError } from "../error.ts"
import {
  AgentJobRepository,
  type IAgentJobRepository
} from "../service/agent-job.repository.ts"

type AgentJobDynamoCommand =
  | PutItemCommand
  | UpdateItemCommand
  | GetItemCommand
  | QueryCommand

type AgentJobDynamoOutput =
  | PutItemCommandOutput
  | UpdateItemCommandOutput
  | GetItemCommandOutput
  | QueryCommandOutput

export interface AgentJobDynamoClient {
  readonly send: (command: AgentJobDynamoCommand) => Promise<AgentJobDynamoOutput>
  readonly destroy?: () => void
}

export interface DynamoAgentJobRepositoryOptions {
  readonly tableName: string
  readonly client?: AgentJobDynamoClient
  readonly clientConfig?: DynamoDBClientConfig
}

const eventKey = (sequence: number) => `EVENT#${sequence.toString().padStart(12, "0")}`

const stringAttribute = (
  item: Record<string, AttributeValue>,
  name: string
): string | undefined => item[name]?.S

const decodeJob = (item: Record<string, AttributeValue>) => {
  const status = stringAttribute(item, "status")
  const common = {
    id: stringAttribute(item, "id"),
    prompt: stringAttribute(item, "prompt"),
    targetRepository: stringAttribute(item, "targetRepository"),
    status,
    createdAt: stringAttribute(item, "createdAt")
  }
  const value = status === "running"
    ? { ...common, startedAt: stringAttribute(item, "startedAt") }
    : status === "succeeded"
      ? {
        ...common,
        startedAt: stringAttribute(item, "startedAt"),
        completedAt: stringAttribute(item, "completedAt"),
        result: stringAttribute(item, "result")
      }
      : status === "failed"
        ? {
          ...common,
          startedAt: stringAttribute(item, "startedAt"),
          completedAt: stringAttribute(item, "completedAt"),
          failure: stringAttribute(item, "failure")
        }
        : common

  return Schema.decodeUnknownEffect(AgentJob)(value)
}

const decodeEvent = (item: Record<string, AttributeValue>) =>
  Schema.decodeUnknownEffect(AgentJobEvent)({
    jobId: stringAttribute(item, "jobId"),
    sequence: item.sequence?.N === undefined ? undefined : Number(item.sequence.N),
    message: stringAttribute(item, "message"),
    createdAt: stringAttribute(item, "createdAt")
  })

export const DynamoAgentJobRepository = ({
  tableName,
  client,
  clientConfig
}: DynamoAgentJobRepositoryOptions) =>
  Layer.effect(
    AgentJobRepository,
    Effect.gen(function*() {
      const dynamo: AgentJobDynamoClient = client ?? (yield* Effect.acquireRelease(
        Effect.sync(() => {
          const aws = clientConfig === undefined
            ? new DynamoDBClient()
            : new DynamoDBClient(clientConfig)
          return {
            send: (command: AgentJobDynamoCommand) =>
              aws.send(command as never) as Promise<AgentJobDynamoOutput>,
            destroy: () => aws.destroy()
          }
        }),
        (client) => Effect.sync(() => client.destroy?.())
      ))

      const send = <A extends AgentJobDynamoOutput>(command: AgentJobDynamoCommand) =>
        Effect.tryPromise({
          try: () => dynamo.send(command) as Promise<A>,
          catch: (cause) => new AgentJobRepositoryError({ cause })
        })

      /**
        * @since
        * @category layer method
        */
      const put: IAgentJobRepository["put"] = Effect.fn(
        "AgentJobRepository.put"
      )(function*(job, createdAtIso) {
        yield* send(new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: `RUN#${job.id}` },
            SK: { S: "RUN" },
            entityType: { S: "AgentRun" },
            id: { S: job.id },
            prompt: { S: job.prompt },
            ...(job.targetRepository === undefined
              ? {}
              : { targetRepository: { S: job.targetRepository } }),
            status: { S: job.status },
            createdAt: { S: createdAtIso },
            createdAtId: { S: `${createdAtIso}#${job.id}` }
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
        }))
      })

      /**
        * @since
        * @category layer method
        */
      const claim: IAgentJobRepository["claim"] = Effect.fn(
        "AgentJobRepository.claim"
      )(function*(id, startedAtIso) {
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              await dynamo.send(new UpdateItemCommand({
                TableName: tableName,
                Key: { PK: { S: `RUN#${id}` }, SK: { S: "RUN" } },
                UpdateExpression: "SET #status = :running, startedAt = :startedAt",
                ConditionExpression: "#status = :queued",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":queued": { S: "queued" },
                  ":running": { S: "running" },
                  ":startedAt": { S: startedAtIso }
                }
              }))
              return true
            } catch (cause) {
              if (cause instanceof ConditionalCheckFailedException) return false
              throw cause
            }
          },
          catch: (cause) => new AgentJobRepositoryError({ cause })
        })
      })

      /**
        * @since
        * @category layer method
        */
      const appendEvent: IAgentJobRepository["appendEvent"] = Effect.fn(
        "AgentJobRepository.appendEvent"
      )(function*(event, createdAtIso) {
        yield* send(new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: `RUN#${event.jobId}` },
            SK: { S: eventKey(event.sequence) },
            entityType: { S: "AgentRunEvent" },
            jobId: { S: event.jobId },
            sequence: { N: String(event.sequence) },
            message: { S: event.message },
            createdAt: { S: createdAtIso }
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
        }))
      })

      const complete = (
        id: Parameters<IAgentJobRepository["succeed"]>[0],
        completedAtIso: string,
        field: "result" | "failure",
        value: string,
        status: "succeeded" | "failed"
      ) => send(new UpdateItemCommand({
        TableName: tableName,
        Key: { PK: { S: `RUN#${id}` }, SK: { S: "RUN" } },
        UpdateExpression: "SET #status = :status, completedAt = :completedAt, #terminalValue = :value",
        ConditionExpression: "#status = :running",
        ExpressionAttributeNames: {
          "#status": "status",
          "#terminalValue": field
        },
        ExpressionAttributeValues: {
          ":running": { S: "running" },
          ":status": { S: status },
          ":completedAt": { S: completedAtIso },
          ":value": { S: value }
        }
      })).pipe(Effect.asVoid)

      /**
        * @since
        * @category layer method
        */
      const succeed: IAgentJobRepository["succeed"] = Effect.fn(
        "AgentJobRepository.succeed"
      )((id, result, completedAtIso) =>
        complete(id, completedAtIso, "result", result, "succeeded"))

      /**
        * @since
        * @category layer method
        */
      const fail: IAgentJobRepository["fail"] = Effect.fn(
        "AgentJobRepository.fail"
      )((id, failure, completedAtIso) =>
        complete(id, completedAtIso, "failure", failure, "failed"))

      /**
        * @since
        * @category layer method
        */
      const get: IAgentJobRepository["get"] = Effect.fn(
        "AgentJobRepository.get"
      )(function*(id) {
        const output = yield* send<GetItemCommandOutput>(new GetItemCommand({
          TableName: tableName,
          Key: { PK: { S: `RUN#${id}` }, SK: { S: "RUN" } },
          ConsistentRead: true
        }))
        if (output.Item === undefined) return undefined
        return yield* decodeJob(output.Item).pipe(
          Effect.mapError((cause) => new AgentJobRepositoryError({ cause }))
        )
      })

      /**
        * @since
        * @category layer method
        */
      const listEventsAfter: IAgentJobRepository["listEventsAfter"] = Effect.fn(
        "AgentJobRepository.listEventsAfter"
      )(function*(id, sequence) {
        const items: Array<Record<string, AttributeValue>> = []
        let exclusiveStartKey: Record<string, AttributeValue> | undefined
        do {
          const output = yield* send<QueryCommandOutput>(new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
            ExpressionAttributeValues: {
              ":pk": { S: `RUN#${id}` },
              ":start": { S: eventKey(sequence + 1) },
              ":end": { S: "EVENT#999999999999" }
            },
            ExclusiveStartKey: exclusiveStartKey,
            ConsistentRead: true,
            ScanIndexForward: true
          }))
          items.push(...(output.Items ?? []))
          exclusiveStartKey = output.LastEvaluatedKey
        } while (exclusiveStartKey !== undefined)

        return yield* Effect.forEach(items, (item) =>
          decodeEvent(item).pipe(
            Effect.mapError((cause) => new AgentJobRepositoryError({ cause }))
          ))
      })

      return AgentJobRepository.of({
        put,
        claim,
        appendEvent,
        succeed,
        fail,
        get,
        listEventsAfter
      })
    })
  )
