import * as AwsCredentials from "@distilled.cloud/aws/Credentials"
import { Region } from "@distilled.cloud/aws/Region"
import * as Microvms from "@distilled.cloud/aws/lambda-microvms"
import { AgentJob } from "@fireclanker/core"
import * as AWS from "alchemy/AWS"
import { Console, Effect, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import {
  AgentMicrovm,
  type AgentMicrovmEvent
} from "./agent-microvm-rpc.ts"
import { consumeAgentMicrovmStream } from "./agent-microvm-response.ts"

export interface AgentJobLiveFeed {
  readonly open: (
    job: AgentJob.RunningAgentJob,
    afterSequence: number
  ) => Stream.Stream<AgentMicrovmEvent, unknown>
}

export const MicrovmAgentJobLiveFeed = (options: {
  readonly region: string
  readonly credentials: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  }
}): AgentJobLiveFeed => ({
  open: (job, afterSequence) => Stream.unwrap(Effect.gen(function*() {
    if (job.microvmId === undefined || job.microvmEndpoint === undefined) {
      return yield* Effect.fail(new Error("Agent microVM connection is unavailable"))
    }
    const createAuthToken = yield* Microvms.createMicrovmAuthToken
    const { authToken } = yield* createAuthToken({
      microvmIdentifier: job.microvmId,
      expirationInMinutes: 10,
      allowedPorts: [{ port: 8080 }]
    })
    const agent = yield* AWS.Lambda.connectMicrovm(AgentMicrovm, {
      endpoint: job.microvmEndpoint,
      authToken
    })
    return agent.watch({ afterSequence })
  }).pipe(
    Effect.provideService(
      AwsCredentials.Credentials,
      Effect.succeed(AwsCredentials.fromAwsCredentialIdentity(options.credentials))
    ),
    Effect.provideService(Region, Effect.succeed(options.region))
  )).pipe(Stream.provide(FetchHttpClient.layer))
})

export const watchAgentJob = (
  id: AgentJob.AgentJobId,
  liveFeed: AgentJobLiveFeed
) => Effect.gen(function*() {
  const service = yield* AgentJob.AgentJobService
  let cursor = 0
  let liveAttempted = false
  let streamedResult: string | undefined

  const drainEvents = Effect.fn("AgentJobLiveWatch.drainEvents")(function*() {
    const events = yield* service.listEventsAfter(id, cursor)
    for (const event of events) {
      yield* Console.log(event.message)
      cursor = event.sequence
    }
  })

  while (true) {
    yield* drainEvents()
    const current = yield* service.get(id)

    if (current.status === "succeeded") {
      yield* drainEvents()
      if (
        streamedResult === undefined ||
        !current.result.startsWith(streamedResult)
      ) {
        yield* Console.log(current.result)
      }
      return
    }
    if (current.status === "failed") {
      yield* drainEvents()
      return yield* Effect.fail(new Error(current.failure))
    }

    if (
      !liveAttempted &&
      current.status === "running" &&
      current.microvmId !== undefined &&
      current.microvmEndpoint !== undefined &&
      current.microvmEventBaseSequence !== undefined
    ) {
      liveAttempted = true
      yield* drainEvents()
      const persistedBeforeMicrovm = current.microvmEventBaseSequence
      const afterSequence = Math.max(0, cursor - persistedBeforeMicrovm)
      let lastLiveLogSequence = afterSequence

      const directResult = yield* consumeAgentMicrovmStream(
        liveFeed.open(current, afterSequence),
        (message, sequence) => Console.log(message).pipe(
          Effect.tap(() => Effect.sync(() => {
            lastLiveLogSequence = sequence
          }))
        ),
        afterSequence
      ).pipe(
        Effect.catchCause(() =>
          Effect.logDebug(
            "Direct agent microVM stream unavailable; using persisted events"
          ).pipe(Effect.as(undefined))
        )
      )
      if (directResult !== undefined) {
        streamedResult = directResult.result
        yield* Console.log(streamedResult)
      }
      cursor = Math.max(
        cursor,
        persistedBeforeMicrovm + lastLiveLogSequence
      )
      continue
    }

    yield* Effect.sleep("1 second")
  }
})
