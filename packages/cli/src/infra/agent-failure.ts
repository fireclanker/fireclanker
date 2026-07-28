const failureMetadata = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null) return {}
  const value = cause as {
    readonly _tag?: unknown
    readonly operation?: unknown
    readonly reason?: unknown
  }
  const errorTag = typeof value._tag === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value._tag)
    ? value._tag
    : undefined
  const operation = typeof value.operation === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value.operation)
    ? value.operation
    : undefined
  const reason = typeof value.reason === "string" &&
      value.reason.length <= 512 &&
      !/[\r\n]/.test(value.reason)
    ? value.reason
    : undefined
  return { errorTag, operation, reason }
}

export const failureDescription = (cause: unknown): string => {
  const { operation } = failureMetadata(cause)
  if (operation === "read-prompt-response") {
    return "OpenCode returned no text response"
  }
  return operation === undefined
    ? "OpenCode execution failed"
    : `OpenCode execution failed during ${operation}`
}

export const failureDiagnostic = (cause: unknown) => {
  const { errorTag, operation, reason } = failureMetadata(cause)
  return {
    ...(errorTag === undefined ? {} : { errorTag }),
    ...(operation === undefined ? {} : { operation }),
    ...(reason === undefined ? {} : { reason })
  }
}
