import { expect, test } from "bun:test"
import {
  failureDescription,
  failureDiagnostic
} from "../src/infra/agent-failure.ts"

test("describes a typed agent failure with its operation", () => {
  const failure = {
    _tag: "AgentMicrovmError",
    operation: "clone-repository",
    reason: "Error: repository not found"
  }

  expect(failureDescription(failure)).toBe(
    "OpenCode execution failed during clone-repository"
  )
  expect(failureDiagnostic(failure)).toEqual({
    errorTag: "AgentMicrovmError",
    operation: "clone-repository",
    reason: "Error: repository not found"
  })
})

test("explains an empty OpenCode response", () => {
  expect(failureDescription({
    _tag: "AgentMicrovmError",
    operation: "read-prompt-response"
  })).toBe("OpenCode returned no text response")
})

test("does not expose malformed operation metadata", () => {
  const failure = {
    _tag: "AgentMicrovmError",
    operation: "prompt-response\nsecret diagnostic",
    reason: "secret\ndiagnostic"
  }

  expect(failureDescription(failure)).toBe("OpenCode execution failed")
  expect(failureDiagnostic(failure)).toEqual({ errorTag: "AgentMicrovmError" })
})
