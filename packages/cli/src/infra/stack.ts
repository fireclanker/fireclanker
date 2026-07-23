import * as Alchemy from "alchemy"
import * as AWS from "alchemy/AWS"
import * as Output from "alchemy/Output"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { Effect } from "effect"
import TableEventsStreamLive, {
  FireclankerTable,
  TableEventsQueue,
  TableEventsStream
} from "./table.ts"
import AgentMicrovmLive from "./agent-microvm.ts"
import { DEPLOYMENT_NAME } from "./constants.ts"
import QueueWorker from "./queue-worker.ts"

export default Alchemy.Stack(
  DEPLOYMENT_NAME,
  {
    providers: AWS.providers(),
    state: AWS.state()
  },
  Effect.gen(function*() {
    const executionRecords = yield* AWS.S3.Bucket("ExecutionRecords", {
      forceDestroy: false
    }).pipe(RemovalPolicy.retain())

    const table = yield* FireclankerTable
    const tableEventsQueue = yield* TableEventsQueue
    yield* TableEventsStream.pipe(Effect.provide(TableEventsStreamLive))
    yield* QueueWorker

    return {
      executionRecordsBucket: executionRecords.bucketName,
      tableName: table.tableName,
      tableArn: table.tableArn,
      tableEventsQueueUrl: tableEventsQueue.queueUrl,
      tableEventsQueueArn: tableEventsQueue.queueArn,
      tableStreamArn: table.latestStreamArn.pipe(
        Output.mapEffect((streamArn) =>
          typeof streamArn === "string"
            ? Effect.succeed(streamArn)
            : Effect.die(new Error("Fireclanker table stream is not enabled"))
        )
      )
    }
  }).pipe(Effect.provide(AgentMicrovmLive))
)
