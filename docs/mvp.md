# fireclanker MVP

fireclanker is a cloud coding agent. It delegates unattended coding tasks to an OpenCode agent running in AWS Lambda.

AWS Lambda's managed Firecracker microVM is the sandbox boundary. fireclanker does not start a nested Firecracker VM inside Lambda.

## Technology

- Effect for application code and the CLI: `@.agents/references/effect-smol/`
- Alchemy for embedded infrastructure: `@.agents/references/alchemy/`
- OpenCode SDK for the coding agent: `@.agents/references/opencode/`
- AWS Bedrock with model ID `global.anthropic.claude-sonnet-4-6`
- AWS Lambda for agent execution
- DynamoDB for run state, results
- S3 for Execution Records: complete versioned OpenCode data archives for succeeded runs and best-effort partial archives for failed runs

## MVP scope

The MVP only needs a working happy path. It does not include Agent Run retries, cancellation, custom timeout handling, multi-user authorization, a web UI, or automatic recovery. Normal AWS SDK transport retries are allowed, but fireclanker does not restart OpenCode execution within an Agent Run. AWS service limits, including Lambda's execution limit, still apply.

An Agent Run finishes successfully with a textual response. Agent Runs do not operate on GitHub repositories or interact with GitHub.

Submitted prompts are trusted in the MVP. Lambda's managed Firecracker microVM isolates compute from the host, but it does not prevent agent tools from discovering or exercising the Lambda execution role. The worker role must therefore be least-privileged to the deployment's resources. The MVP does not provide hostile-prompt isolation from AWS resources.

## Configuration and deployment

The application uses `~/.config/fireclanker/config.json`:

```json
{
  "name": "fireclanker",
  "region": "us-east-1"
}
```

The file contains only:

- `name`: the deployment name and prefix used for AWS resources.
- `region`: the AWS region containing the deployment.

AWS credentials are not stored in this file. They come from the active AWS credential chain.

Deploy with:

```sh
assume sandbox --exec -- fireclanker deploy
```

`deploy` is the only command that can run without the configuration file. When the file is absent, `name` defaults to `fireclanker` and `region` comes from the active AWS configuration. The command accepts `--name` and `--region` to override file or default values.

```sh
assume sandbox --exec -- fireclanker deploy --name fireclanker --region us-east-1
```

After deployment succeeds, `deploy` writes the effective `name` and `region` to the configuration file. A failed deployment does not replace an existing configuration. The active AWS account, effective region, and deployment name identify a deployment; deploying the same tuple again updates that deployment.

All other commands use the configured `name` and `region`, together with the active AWS credential chain, to locate the deployed DynamoDB table and related resources.

## CLI

### Submit a run

```sh
assume sandbox --exec -- fireclanker run "hi"
```

`run` accepts a prompt, creates a queued Agent Run in DynamoDB, and returns immediately after printing its ID. It does not accept `--repo` or `--repos`.

### Submit and watch a run

```sh
assume sandbox --exec -- fireclanker run --watch "hi"
```

`--watch` creates the same queued Agent Run, prints its ID, then polls its persisted events and prints new OpenCode events until the run succeeds or fails. After observing a terminal state, it drains all remaining events before printing the final result or failure description. It exits non-zero when the Agent Run fails.

The watch mode does not require a separate streaming service. Events are persisted by the worker and queried from DynamoDB by the CLI.

The MVP does not include a command for resuming a watch on an existing Agent Run. After an interrupted watch, `get` can retrieve the run's current state.

Watch mode has no client-side timeout. If a run is stranded in `queued` or `running`, watch continues polling until the user interrupts it.

### List runs

```sh
assume sandbox --exec -- fireclanker list
```

`list` prints all Agent Runs in the configured deployment, transparently traversing storage pages. Runs appear in deterministic reverse creation order, with equal creation times ordered by Agent Run ID. It prints at least:

- Agent Run ID
- status
- creation time
- response when succeeded
- failure description when failed

### Get a run

```sh
assume sandbox --exec -- fireclanker get <agent-run-id>
```

`get` prints the current state of an Agent Run. For a succeeded run it also prints the textual response; for a failed run it prints the failure description. Retrieving a failed run still exits zero because the read succeeded. Missing IDs and read failures exit non-zero.

CLI output is human-oriented. The MVP does not define a stable JSON output contract; plain `run` is the exception and prints only the new Agent Run ID.

## Agent Run domain

Agent Run is the central aggregate. It owns the requested work, lifecycle, and final result.

One Agent Run represents exactly one requested execution. Repeating the same prompt creates a new Agent Run with a new ID. An Agent Run is never restarted or returned to `queued`.

### Lifecycle

```text
queued -> running -> succeeded
                  -> failed
```

- `queued` means the run is durably accepted and eligible for a worker to claim. It does not guarantee eventual execution.
- `running` means one worker atomically claimed the run. It does not guarantee that worker is still live.
- `succeeded` means OpenCode completed, produced a non-empty textual response, every event delivered during the run's event-observation window was durably stored, and a complete Execution Record was durably stored. It does not judge whether the response fulfilled the prompt correctly.
- `failed` means the worker durably recorded a technical failure. A refusal or negative answer returned as text is still a successful result.

Only caught failures that the worker can still persist become `failed`. A lost stream delivery can leave a run `queued`; a worker crash, hard Lambda timeout, or failure to persist a terminal state can leave it `running`. Recovery for stranded runs is outside the MVP.

The minimum Agent Run data is:

- ID
- prompt
- status
- creation, start, and completion timestamps
- final result or failure description

The Agent Run ID is opaque and globally unique; it does not encode deployment, chronology, or lifecycle data. The prompt is immutable, must contain at least one non-whitespace character, and is otherwise preserved exactly as supplied.

Lifecycle timestamps are UTC instants written atomically with their transitions: creation with `queued`, start with the claim to `running`, and completion with a terminal outcome. Timestamps that do not apply to the current state are absent.

The persisted Agent Run schema is a status-discriminated union:

- `queued` contains creation data.
- `running` adds the start timestamp.
- `succeeded` adds the completion timestamp and result.
- `failed` adds the completion timestamp and failure description.

The transition to a terminal state conditionally requires `running` and atomically writes the status, completion timestamp, and either result or failure description. Terminal states never transition again.

Lifecycle and result are separate concepts. `succeeded` describes execution state, while the result describes what the successful run produced. A failure description is a concise user-facing explanation, not a result; it must exclude secrets, stack traces, and raw provider payloads.

### Result

```ts
type AgentRunResult =
  {
    readonly response: string
  }
```

The response is the non-empty text content of OpenCode's final assistant message, preserving the order and content of its text parts. Intermediate assistant messages remain part of the Execution Record. Ending without a non-empty final text part is a failure.

Domain entities should use `Model.Class`. Identifiers and validated primitives should use branded types. Persisted models must have Effect schemas so the DynamoDB boundary can encode and decode them.

Suggested value objects include:

- `AgentRunId`
- `AgentPrompt`

## Execution flow

The application has a direct AWS architecture:

```text
CLI -> DynamoDB -> DynamoDB Stream -> Worker Lambda -> DynamoDB
```

1. The CLI writes a new queued Agent Run to DynamoDB.
2. A DynamoDB Stream receives the insert.
3. The stream invokes the worker Lambda for newly inserted queued Agent Runs, with one Agent Run per invocation.
4. The worker conditionally changes the status from `queued` to `running`.
5. The worker prepares a fresh isolated workspace and OpenCode data directory with no repository checkout.
6. OpenCode runs unattended with its normal coding tools, including shell execution, workspace writes, and outbound network access, using the configured Bedrock model.
7. Before creating the OpenCode session, the worker establishes the live event subscription. From session creation until the subscription is closed after prompt completion, each event delivered by that subscription is persisted to DynamoDB. Losing the subscription or failing to persist a delivered event fails the run.
8. The worker extracts the textual response from OpenCode's final assistant message.
9. After the prompt completes, the worker drains delivered events, closes the subscription, and cleanly stops the local OpenCode server.
10. The worker stores a versioned archive of the entire per-run OpenCode data directory in S3. The archive includes a manifest with the archive format version, OpenCode version, and Agent Run ID, plus every data-directory file after shutdown, including the SQLite database and any full tool-output side files. The upload and checksum must be verified.
11. Only after the complete Execution Record is verified does the worker atomically store the textual result and mark the run `succeeded`.
12. If execution fails while the worker can still write, it stops OpenCode, preserves any partial Execution Record it can, stores a sanitized failure description, and marks the run `failed`. Abrupt termination may prevent any Execution Record from being stored.

Files created in the run workspace are ephemeral execution aids. They are not retained as results or retrievable artifacts. The Execution Record is operational data and has no MVP CLI retrieval command; it can be accessed through S3 and AWS tooling.

The DynamoDB Stream event source must filter for inserted records whose entity type is `AgentRun` and whose status is `queued`, and its batch size is one. Agent events and status updates written to the same table must not start another worker invocation.

Duplicate stream delivery is expected. A conditional claim of a non-queued run is a successful no-op, not an invocation failure and never a reason to execute the run again.

## DynamoDB model

The MVP can use a single DynamoDB table for runs and events:

```text
PK                 SK                  entityType
RUN#<id>           RUN                 AgentRun
RUN#<id>           EVENT#<event-id>    AgentRunEvent
```

Each OpenCode event delivered during the event-observation window produces exactly one append-only Agent Run Event. Events contain the run ID, a stable event ID, event type, timestamp, and a bounded representation of the serializable OpenCode event data. They have a total per-run order independent of timestamps, allowing `--watch` to query only events after its last cursor. Oversized details remain in the S3 Execution Record and may be represented by a reference in the event.

Agent Run Events are the ordered watch feed, not the canonical complete execution history. After observing a terminal state, watch uses a strongly consistent event query to drain events committed before that terminal transition. The table includes an index that allows `list` to query Agent Run records in reverse creation order. The Agent Run store uses conditional updates for lifecycle transitions so a stream event cannot execute the same queued run twice.

Agent Runs, Agent Run Events, and Execution Records have no TTL or per-run delete operation in the MVP. Redeployment preserves them for the lifetime of the deployment.

## Lambda packaging

The worker is an arm64 ZIP Lambda. The deployment pins the `opencode-linux-arm64` package, includes it through Alchemy's package installation support, then copies the executable to `/tmp` and sets its executable permission before starting OpenCode. The worker points its home and XDG directories at per-run locations under Lambda's writable temporary storage.

The final deployment bundle must be checked against Lambda's 250 MiB uncompressed ZIP limit. OpenCode and the worker's runtime data must also fit the available temporary storage. Exceeding either limit requires revisiting the execution architecture rather than deploying an incomplete OpenCode runtime.

## Services and layers

A Service is a port and a Layer is an adapter. Service interfaces remain independent from concrete AWS and OpenCode implementations.

The Agent Run persistence Service exposes domain lifecycle operations such as `create`, `claim`, `succeed`, `fail`, `get`, and `list`, rather than generic record writes. It owns conditional transitions and atomic state-field invariants. `claim` reports an already-claimed or terminal run as an expected not-claimed outcome; storage and decoding problems remain errors.

Agent Run Events and Execution Records are run-scoped records outside the Agent Run aggregate. Their persistence Services expose append/archive operations without making their unbounded data part of ordinary aggregate reads.

Service:

```ts
// packages/core/src/example/service/example-service.ts

/**
 * @since 0.0.0
 * @category service-interface
 */
export interface IExampleService {
  /**
   * @since 0.0.0
   * @category service-method-interface
   */
  readonly method: () => Effect.Effect<void>
}

/**
 * @since 0.0.0
 * @category service
 */
export class ExampleService extends Context.Service<ExampleService, IExampleService>()(
  "ExampleService",
) {}
```

Layer:

```ts
// packages/core/src/example/layer/infra-example-service.ts

/**
 * @since 0.0.0
 * @category layer
 */
export const InfraExampleService = Layer.effect(
  ExampleService,
  Effect.gen(function* () {
    /**
     * @since 0.0.0
     * @category service-method
     */
    const method: IExampleService["method"] = Effect.fn(
      "ExampleService.method",
    )(function* () {
      // Implement the adapter operation.
    })

    return ExampleService.of({ method })
  }),
)
```
