# Agent Execution

This context describes unattended coding work delegated to a cloud coding agent and the record of each execution.

## Language

**Agent Run**:
One requested execution of a prompt by the coding agent, owning its requested work, lifecycle, and terminal outcome. Repeating the same work creates a new Agent Run; an existing Agent Run is never restarted. Its Agent Run Events and Execution Record are associated records outside the aggregate.
_Avoid_: Job, task, retry

**Agent Run ID**:
An opaque, globally unique identity assigned when an Agent Run is requested. It carries no deployment, chronology, or lifecycle meaning.
_Avoid_: Sequence number, timestamp

**Agent Prompt**:
The immutable user-supplied instruction for one Agent Run. It contains at least one non-whitespace character and preserves the text as supplied.
_Avoid_: Query, message, task

**Trusted Prompt**:
An Agent Prompt assumed not to intentionally misuse the coding agent's runtime permissions. Compute isolation does not make a hostile prompt trusted.
_Avoid_: Safe prompt, sandboxed prompt

**Target Repository**:
The single GitHub repository bound to an Agent Run at request time, cloned into its Run Workspace by the worker. An Agent Run has at most one, and repository content is never a Trusted Prompt.
_Avoid_: Repo, project, checkout

**Queued**:
The Agent Run has been durably accepted and is eligible for a worker to claim. It does not guarantee that execution will eventually begin.
_Avoid_: Scheduled, guaranteed

**Running**:
The Agent Run has been exclusively claimed by one worker for execution. It does not assert that the worker is still live.
_Avoid_: Live, healthy

**Succeeded**:
The Agent Run completed, produced a textual response, and durably preserved its complete Execution Record and every Agent Run Event observed during execution. It does not assert that the response correctly fulfilled the prompt. For an Agent Run bound to a Target Repository, it additionally requires the publish step to have completed: a Publication was recorded, or the run legitimately had nothing to publish.
_Avoid_: Correct, fulfilled

**Failed**:
The durably recorded terminal outcome of an Agent Run when a technical problem prevented it from producing a textual response or preserving its required execution records. A textual refusal or negative answer is not a failure, and an abruptly terminated worker may leave the Agent Run recorded as Running instead.
_Avoid_: Incorrect, rejected

**Agent Run Result**:
The non-empty text of the coding agent's final assistant message, preserving the order and content of its text parts. It is distinct from intermediate messages and from the Agent Run's execution outcome.
_Avoid_: Success, outcome

**Failure Description**:
The concise, user-facing explanation of why an Agent Run failed. It excludes secrets and raw diagnostic detail and is not an Agent Run Result.
_Avoid_: Result, response

**Run Workspace**:
The temporary filesystem available to one Agent Run. Its files are execution aids, not durable results or retrievable artifacts.
_Avoid_: Repository, artifact store

**Execution Record**:
The durable record of the agent's messages, tool calls, and other activity during an Agent Run. It is complete for a succeeded Agent Run and may be partial or absent when the Agent Run fails.
_Avoid_: Agent Run Result, event feed

**Agent Run Event**:
An append-only observation of coding-agent activity during an Agent Run, used to follow execution progress. Each observed activity has one stable event identity and a total order within its Agent Run; Agent Run Events are not the complete Execution Record.
_Avoid_: Execution Record, result
