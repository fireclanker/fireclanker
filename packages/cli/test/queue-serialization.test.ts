import { expect, test } from "bun:test"
import {
  queuedAgentRunMessage,
  tableEventsQueueProps
} from "../src/infra/queue-serialization.ts"

test("serializes agent runs without Lambda reserved concurrency", () => {
  expect(tableEventsQueueProps).toMatchObject({
    fifo: true,
    contentBasedDeduplication: true,
    visibilityTimeout: 660
  })
  expect(queuedAgentRunMessage("job-123")).toEqual({
    MessageBody: JSON.stringify({
      version: 1,
      jobId: "job-123"
    }),
    MessageGroupId: "agent-runs",
    MessageDeduplicationId: "job-123"
  })
})
