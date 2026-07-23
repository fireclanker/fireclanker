import { AgentJob } from "@fireclanker/core"
import * as AWS from "alchemy/AWS"
import { Duration, Effect, Layer, Schedule, Schema, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { AgentMicrovm, AgentMicrovmExecutionRole } from "./agent-microvm.ts"
import { TABLE_NAME } from "./constants.ts"
import { FireclankerTable, TableEventsQueue } from "./table.ts"

const parseJobId = (body: string) => Effect.try({
  try: () => JSON.parse(body) as { jobId?: unknown },
  catch: (cause) => new Error("Invalid queue message", { cause })
}).pipe(
  Effect.flatMap((message) => Schema.decodeUnknownEffect(AgentJob.AgentJobId)(message.jobId))
)

const sanitizeFailure = () => "OpenCode execution failed"

export class QueueWorker extends AWS.Lambda.Function<QueueWorker>()(
  "QueueWorker",
  {
    main: import.meta.filename,
    architecture: "arm64",
    timeout: Duration.minutes(5),
    memorySize: 1024,
    env: { FIRECLANKER_NAME: TABLE_NAME }
  },
  Effect.gen(function*() {
    const table = yield* FireclankerTable
    const queue = yield* TableEventsQueue
    const executionRole = yield* AgentMicrovmExecutionRole
    const executionRoleArn = yield* executionRole.roleArn
    const host = yield* AWS.Lambda.Function
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(AgentMicrovm)
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(AgentMicrovm)
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(AgentMicrovm)
    const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(AgentMicrovm)

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind`Allow(${host}, AgentJobStore(${table}))`({
        policyStatements: [{
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem"
          ],
          Resource: [table.tableArn]
        }]
      })
      yield* host.bind`Allow(${host}, PassRole(${executionRole}))`({
        policyStatements: [{
          Effect: "Allow",
          Action: ["iam:PassRole"],
          Resource: [executionRole.roleArn]
        }]
      })
    }

    const agentJobLayer = AgentJob.AgentJobServiceLive.pipe(
      Layer.provide(AgentJob.DynamoAgentJobRepository({ tableName: TABLE_NAME }))
    )

    const processMessage = Effect.fn("QueueWorker.processMessage")(function*(body: string) {
      const id = yield* parseJobId(body)
      const service = yield* AgentJob.AgentJobService
      const claimed = yield* service.claim(id)
      if (!claimed) {
        yield* Effect.logInfo("Ignoring an already claimed job", { id })
        return
      }

      let sequence = 0
      const append = (message: string) => Effect.logInfo(message, { id }).pipe(
        Effect.andThen(service.appendEvent(id, ++sequence, message))
      )

      const execute = Effect.gen(function*() {
        const job = yield* service.get(id)
        yield* append("[lambda] worker claimed job")
        yield* append("[lambda] starting agent microvm")
        const vm = yield* runMicrovm({
          executionRoleArn: yield* executionRoleArn,
          maximumDurationInSeconds: 240
        })

        const response = yield* Effect.gen(function*() {
          yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
            Effect.flatMap((state) => state.state === "RUNNING"
              ? Effect.void
              : Effect.fail(new Error(`microvm ${state.state}`))),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 })
          )
          yield* append("[lambda] agent microvm is running")

          const { authToken } = yield* createAuthToken({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }]
          })
          const agent = yield* AWS.Lambda.connectMicrovm(AgentMicrovm, {
            endpoint: vm.endpoint,
            authToken
          })
          return yield* agent.run(job.prompt)
        }).pipe(
          Effect.ensuring(
            terminateMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
              Effect.retry({ schedule: Schedule.spaced("1 second"), times: 3 }),
              Effect.catch((cause) =>
                Effect.logError("Could not terminate agent microvm", {
                  id,
                  microvmId: vm.microvmId,
                  cause
                })
              )
            )
          ),
          Effect.provide(FetchHttpClient.layer)
        )

        for (const message of response.logs) yield* append(message)
        yield* append("[lambda] job finished")
        yield* service.succeed(id, response.result)
        yield* Effect.logInfo("OpenCode job succeeded", { id })
      })

      yield* execute.pipe(
        Effect.catch((cause) =>
          service.fail(id, sanitizeFailure()).pipe(
            Effect.andThen(Effect.logError("OpenCode job failed", { id, cause })),
            Effect.catch((terminalCause) =>
              Effect.logError("Could not record OpenCode job failure", { id, terminalCause })
            )
          )
        )
      )
    })

    yield* AWS.SQS.consumeQueueMessages(queue, { batchSize: 1 }, (records) =>
      records.pipe(
        Stream.runForEach((record) => processMessage(record.body).pipe(
          Effect.provide(agentJobLayer),
          Effect.scoped,
          Effect.orDie
        ))
      )
    )

    return {}
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.QueueEventSource,
        AWS.Lambda.RunMicrovmHttp,
        AWS.Lambda.GetMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
        AWS.Lambda.TerminateMicrovmHttp
      )
    )
  )
) {}

export default QueueWorker
