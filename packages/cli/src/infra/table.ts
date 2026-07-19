import * as AWS from "alchemy/AWS"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { Context, Effect, Layer, Stream } from "effect"
import { TABLE_NAME } from "./constants.ts"

/**
 * The single DynamoDB table for all Fireclanker data.
 *
 * Agent Runs use one item collection per run:
 *
 * ```text
 * PK                 SK                     entityType
 * RUN#<id>           RUN                    AgentRun
 * RUN#<id>           EVENT#<event-id>       AgentRunEvent
 * ```
 *
 * The Agent Run aggregate lives at the `RUN` sort key; ordered Agent Run
 * Events live under `EVENT#` sort keys in the same collection.
 *
 * `AgentRunsByCreatedAt` backs `list`: a sparse GSI over aggregate records
 * only (Agent Run Events never carry `createdAtId`). Its sort key is the
 * composite `<createdAt ISO-8601 UTC instant>#<Agent Run ID>`, giving a
 * deterministic total order — reverse creation with the Agent Run ID as the
 * tie-breaker — that holds across storage pages.
 *
 * The DynamoDB Stream is enabled with `NEW_IMAGE` by `TableEventsStream`,
 * which forwards each change record to `TableEventsQueue` for downstream
 * processing.
 *
 * Agent Runs and Agent Run Events are retained for the deployment lifetime:
 * no TTL, the table is retained on stack destroy, and deletion protection is
 * on. Conditional lifecycle transitions are enforced by the Agent Run
 * persistence Service, not by the table.
 */
export const FireclankerTable = Effect.gen(function*() {
  return yield* AWS.DynamoDB.Table("Table", {
    tableName: TABLE_NAME,
    partitionKey: "PK",
    sortKey: "SK",
    attributes: {
      PK: "S",
      SK: "S",
      entityType: "S",
      createdAtId: "S"
    },
    globalSecondaryIndexes: [
      {
        IndexName: "AgentRunsByCreatedAt",
        KeySchema: [
          { AttributeName: "entityType", KeyType: "HASH" },
          { AttributeName: "createdAtId", KeyType: "RANGE" }
        ],
        Projection: { ProjectionType: "ALL" }
      }
    ],
    billingMode: "PAY_PER_REQUEST",
    deletionProtectionEnabled: true
  }).pipe(RemovalPolicy.retain())
})

export const TableEventsQueue = AWS.SQS.Queue("TableEventsQueue")

class TableResources extends Context.Service<
  TableResources,
  {
    readonly table: AWS.DynamoDB.Table
    readonly queue: AWS.SQS.Queue
  }
>()("TableResources") {}

const TableResourcesLive = Layer.effect(
  TableResources,
  Effect.gen(function*() {
    return {
      table: yield* FireclankerTable,
      queue: yield* TableEventsQueue
    }
  })
)

export class TableEventsStream extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "TableEventsStream"
) {}

export default TableEventsStream.make(
  { main: import.meta.url },
  Effect.gen(function*() {
    const { table, queue } = yield* TableResources
    const sink = yield* AWS.SQS.QueueSink(queue)

    yield* AWS.DynamoDB.consumeTableChanges(
      table,
      {
        streamViewType: "NEW_IMAGE",
        startingPosition: "LATEST",
        batchSize: 10
      },
      (records) =>
        records.pipe(
          Stream.map((record) => JSON.stringify(record)),
          Stream.run(sink),
          Effect.orDie
        )
    )
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          AWS.Lambda.TableEventSource,
          AWS.SQS.QueueSinkHttp,
          TableResourcesLive
        ),
        AWS.SQS.SendMessageBatchHttp
      )
    )
  )
)
