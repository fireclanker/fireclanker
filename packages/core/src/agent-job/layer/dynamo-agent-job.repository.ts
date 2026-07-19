import {
  DynamoDBClient,
  PutItemCommand,
  type PutItemCommandOutput
} from "@aws-sdk/client-dynamodb"
import { Effect, Layer } from "effect"
import { AgentJobRepositoryError } from "../error.ts"
import {
  AgentJobRepository,
  type IAgentJobRepository
} from "../repository/agent-job.repository.ts"

export interface AgentJobDynamoClient {
  readonly send: (command: PutItemCommand) => Promise<PutItemCommandOutput>
}

export interface DynamoAgentJobRepositoryOptions {
  readonly tableName: string
  readonly client?: AgentJobDynamoClient
}

export const DynamoAgentJobRepository = ({
  tableName,
  client
}: DynamoAgentJobRepositoryOptions) =>
  Layer.effect(
    AgentJobRepository,
    Effect.gen(function*() {
      const dynamo = client ?? (yield* Effect.acquireRelease(
        Effect.sync(() => new DynamoDBClient()),
        (client) => Effect.sync(() => client.destroy())
      ))

      const put: IAgentJobRepository["put"] = Effect.fn(
        "AgentJobRepository.put"
      )(function*(job, createdAtIso) {
        yield* Effect.tryPromise({
          try: () => dynamo.send(new PutItemCommand({
            TableName: tableName,
            Item: {
              PK: { S: `RUN#${job.id}` },
              SK: { S: "RUN" },
              entityType: { S: "AgentRun" },
              id: { S: job.id },
              prompt: { S: job.prompt },
              status: { S: job.status },
              createdAt: { S: createdAtIso },
              createdAtId: { S: `${createdAtIso}#${job.id}` }
            },
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
          })),
          catch: (cause) => new AgentJobRepositoryError({ cause })
        })
      })

      return AgentJobRepository.of({ put })
    })
  )
