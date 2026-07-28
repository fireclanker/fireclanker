export const tableEventsQueueProps = {
  visibilityTimeout: 660,
  fifo: true,
  contentBasedDeduplication: true
} as const

export const queuedAgentRunMessage = (jobId: string) => ({
  MessageBody: JSON.stringify({
    version: 1,
    jobId
  }),
  MessageGroupId: "agent-runs",
  MessageDeduplicationId: jobId
})
