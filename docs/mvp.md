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
- GitHub Apps for short-lived access to private Source Repositories
- AWS Systems Manager Parameter Store for the GitHub App credentials

## MVP scope

The MVP only needs a working happy path. It does not include Agent Run retries, cancellation, custom timeout handling, multi-user authorization, a web UI, or automatic recovery. Normal AWS SDK transport retries are allowed, but fireclanker does not restart OpenCode execution within an Agent Run. AWS service limits, including Lambda's execution limit, still apply.

An Agent Run operates read-only on one GitHub Source Repository and finishes successfully with a textual response. The MVP clones the repository's default branch with complete file contents but without history beyond the checked-out tip, submodule initialization, Git LFS object fetching, branch pushes, or pull request creation. Workspace changes remain ephemeral.

Submitted prompts are trusted in the MVP. Lambda's managed Firecracker microVM isolates compute from the host, but it does not prevent agent tools from discovering or exercising the agent microVM execution role. That role must therefore be least-privileged and distinct from the queue worker role used to orchestrate runs and mint checkout credentials. The MVP does not provide hostile-prompt isolation from resources available through the agent microVM execution role.

## Configuration and deployment

The application uses `~/.config/fireclanker/config.json`:

```json
{
  "name": "fireclanker",
  "region": "us-east-1",
  "awsProfile": "sandbox-us",
  "githubOrganization": "fireclanker"
}
```

The file contains only:

- `name`: the deployment name and prefix used for AWS resources.
- `region`: the AWS region containing the deployment.
- `awsProfile`: the profile in `~/.aws/config` used for AWS credentials.
- `githubOrganization`: the GitHub organization that owns the deployment's GitHub App.

AWS credentials are not stored in this file. The AWS SDK resolves them from the configured profile.

Initialize Fireclanker before using any other command:

```sh
fireclanker init
```

`init` interactively asks for all four settings and writes the configuration file. All other commands require this file and fail with setup instructions when it is absent.

For an SSO profile, authenticate it before deploying:

```sh
aws sso login --profile sandbox-us
fireclanker deploy
```

The configured AWS account, region, and deployment name identify a deployment; deploying the same tuple again updates that deployment. Commands use the configured `name`, `region`, and `awsProfile` to locate it. The GitHub organization owns a private GitHub App dedicated to that deployment.

On the first deploy, Fireclanker reserves the SSM `SecureString` parameter `/fireclanker/<name>/github-app` with a `pending` envelope, then opens GitHub's App manifest flow in the operator's browser. An organization owner approves creation of a private App with repository Contents and Pull requests write permissions. Fireclanker exchanges the one-time manifest code and replaces the pending value with the App ID, slug, organization, and private key. The private key is not written to the local configuration, process environment, Alchemy state, stack outputs, or logs. Later deploys validate and reuse the ready parameter and do not create another App. The organization owner follows the emitted installation URL and installs the created App on the repositories Fireclanker may access.

The pending envelope serializes first deployment so concurrent deploys cannot create multiple Apps. If registration is interrupted after the reservation, deployment stops rather than guessing whether GitHub created an App. An operator must inspect the organization's GitHub App settings, remove any orphaned App, and then remove the pending parameter before retrying. Destroying the AWS stack intentionally retains both the out-of-band parameter and GitHub App; deleting credentials without deleting the corresponding App would leave an unrecoverable registration.

## CLI

### Submit a run

```sh
fireclanker run --repo fireclanker/example "hi"
```

`run` requires one `--repo owner/name` Source Repository and a prompt, creates a queued Agent Run in DynamoDB, and returns immediately after printing its ID. The repository value is a canonical GitHub owner and repository name, not a clone URL; arbitrary hosts, embedded credentials, and multiple repositories are rejected. Revision selection is outside the MVP, so execution checks out the repository's default branch as it exists when the worker clones it.

### Submit and watch a run

```sh
fireclanker run --watch --repo fireclanker/example "hi"
```

`--watch` creates the same queued Agent Run, prints its ID, then polls its persisted events and prints new OpenCode events until the run succeeds or fails. After observing a terminal state, it drains all remaining events before printing the final result or failure description. It exits non-zero when the Agent Run fails.

The watch mode does not require a separate streaming service. Events are persisted by the worker and queried from DynamoDB by the CLI.

The MVP does not include a command for resuming a watch on an existing Agent Run. After an interrupted watch, `get` can retrieve the run's current state.

Watch mode has no client-side timeout. If a run is stranded in `queued` or `running`, watch continues polling until the user interrupts it.

### List runs

```sh
fireclanker list
```

`list` prints all Agent Runs in the configured deployment, transparently traversing storage pages. Runs appear in deterministic reverse creation order, with equal creation times ordered by Agent Run ID. It omits the Source Repository field for historical records created before repository support. It prints at least:

- Agent Run ID
- Source Repository
- status
- creation time
- response when succeeded
- failure description when failed

### Get a run

```sh
fireclanker get <agent-run-id>
```

`get` prints the current state and Source Repository of an Agent Run. Historical Agent Runs created before Source Repository support have no Source Repository and remain readable. For a succeeded run it also prints the textual response; for a failed run it prints the failure description. Retrieving a failed run still exits zero because the read succeeded. Missing IDs and read failures exit non-zero.

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

The minimum data for an Agent Run created with Source Repository support is:

- ID
- prompt
- Source Repository owner and repository name
- status
- creation, start, and completion timestamps
- final result or failure description

The Agent Run ID is opaque and globally unique; it does not encode deployment, chronology, or lifecycle data. The prompt is immutable, must contain at least one non-whitespace character, and is otherwise preserved exactly as supplied. The Source Repository selection is also immutable. New Agent Runs require it, while persisted records created before repository support remain decodable without it.

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
- `SourceRepository`

## Execution flow

The application has a direct AWS architecture:

```text
CLI -> DynamoDB -> DynamoDB Stream -> Worker Lambda -> DynamoDB
```

1. The CLI writes a new queued Agent Run to DynamoDB.
2. A DynamoDB Stream receives the insert.
3. The stream invokes the worker Lambda for newly inserted queued Agent Runs, with one Agent Run per invocation.
4. The worker conditionally changes the status from `queued` to `running`.
5. The worker prepares a fresh isolated Run Workspace and OpenCode data directory.
6. For a public Source Repository, the queue worker requests a clone without credentials. For a private Source Repository, the queue worker reads the deployment's GitHub App credentials from its SSM SecureString, mints a short-lived, repository-scoped installation token, and passes it to the separately launched agent microVM, whose execution role cannot read the parameter. The token remains separate from the Agent Prompt and persisted Agent Run.
7. The microVM creates a shallow, single-branch Repository Checkout of the default branch. Authentication is supplied only to the clone process; it is absent from the clone URL and repository configuration, and the token, helper files, and token-bearing environment are removed before OpenCode starts. The checkout contains complete file blobs so later reads do not require the token.
8. OpenCode runs unattended in the Repository Checkout with its normal coding tools, including shell execution, workspace writes, and outbound network access, using the configured Bedrock model. It has no GitHub credential and cannot push workspace changes.
9. Before creating the OpenCode session, the worker establishes the live event subscription. From session creation until the subscription is closed after prompt completion, each event delivered by that subscription is persisted to DynamoDB. Losing the subscription or failing to persist a delivered event fails the run.
10. The worker extracts the textual response from OpenCode's final assistant message.
11. After the prompt completes, the worker drains delivered events, closes the subscription, and cleanly stops the local OpenCode server.
12. The worker stores a versioned archive of the entire per-run OpenCode data directory in S3. The archive includes a manifest with the archive format version, OpenCode version, and Agent Run ID, plus every data-directory file after shutdown, including the SQLite database and any full tool-output side files. The upload and checksum must be verified.
13. Only after the complete Execution Record is verified does the worker atomically store the textual result and mark the run `succeeded`.
14. If execution fails while the worker can still write, it stops OpenCode, preserves any partial Execution Record it can, stores a sanitized failure description, and marks the run `failed`. Abrupt termination may prevent any Execution Record from being stored.

The Repository Checkout and files created in the Run Workspace are ephemeral execution aids. They are not retained as results or retrievable artifacts. The Execution Record is operational data and has no MVP CLI retrieval command; it can be accessed through S3 and AWS tooling.

GitHub credentials are transport secrets rather than Agent Run data. App private keys and installation tokens must never be stored in DynamoDB, included in an Agent Prompt or clone URL, intentionally exposed to OpenCode, or emitted in events, results, failure descriptions, and logs. Only the queue worker role may decrypt the deployment's GitHub App SSM parameter and mint installation tokens; the agent microVM execution role cannot. The agent microVM receives only the per-run installation token needed for checkout and removes its access to that token before OpenCode starts.

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
