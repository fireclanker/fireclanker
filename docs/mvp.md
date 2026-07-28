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

An Agent Run operates on one GitHub Source Repository, optionally starting from an explicit Source Branch, and finishes successfully with a textual response. The queue worker offers a new draft pull request and any explicitly referenced open Fireclanker pull requests as Publication Options. The coding agent selects the target before editing, works from that target's exact head, then decides whether to publish or leave its workspace changes ephemeral. GitHub writes are performed by the queue worker after the microVM terminates.

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
fireclanker run --repo fireclanker/example@feature/starting-point "hi"
```

`run` requires one `--repo owner/name[@branch]` Source Repository argument and a prompt, creates a queued Agent Run in DynamoDB, and returns immediately after printing its ID. The optional suffix selects the Source Branch explicitly; without it, execution uses the repository's default branch. The repository value is a canonical GitHub owner and repository name, not a clone URL; arbitrary hosts, embedded credentials, invalid Git branch names, and multiple repositories are rejected.

### Submit and watch a run

```sh
fireclanker run --watch --repo fireclanker/example "hi"
```

`--watch` creates the same queued Agent Run and prints its ID. While the run is queued, it polls persisted events. Once the queue worker advertises the running agent microVM's non-secret identifier and endpoint, the CLI mints its own short-lived, port-scoped microVM auth token and attaches directly to the replayable live event stream. The CLI prints the textual response from the stream's completion event, then returns to persisted events for publication progress and terminal confirmation without printing the persisted response twice.

The queue worker consumes the same sequenced microVM stream and persists its bounded log events in DynamoDB. If direct attachment is unavailable because of IAM permissions, connection timing, or transport failure, watch transparently continues from those persisted events without failing the Agent Run. The microVM auth token is held only by the CLI process and is never stored in DynamoDB.

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
- optional Source Branch
- status
- creation, start, and completion timestamps
- final result or failure description

The Agent Run ID is opaque and globally unique; it does not encode deployment, chronology, or lifecycle data. The prompt is immutable, must contain at least one non-whitespace character, and is otherwise preserved exactly as supplied. The Source Repository and optional Source Branch selections are also immutable. New Agent Runs require a Source Repository, while persisted records created before repository support remain decodable without it.

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
- `SourceBranch`

## Execution flow

The application has a direct AWS architecture with an optional live observation path:

```text
CLI -> DynamoDB -> DynamoDB Stream -> Worker Lambda -> DynamoDB
                                      |           ^
                                      v           |
                                 agent microVM ----+
                                      |
                                      +-----------> CLI (--watch)
```

1. The CLI writes a new queued Agent Run to DynamoDB.
2. A DynamoDB Stream receives the insert.
3. The stream invokes the worker Lambda for newly inserted queued Agent Runs, with one Agent Run per invocation.
4. The worker conditionally changes the status from `queued` to `running`.
5. The worker prepares a fresh isolated Run Workspace and OpenCode data directory.
6. The queue worker reads the deployment's GitHub App credentials, resolves the selected Source Branch or repository default branch, and discovers open same-repository pull requests whose heads use the `fireclanker/` prefix. It offers the new-PR option plus existing pull requests explicitly referenced by the Agent Prompt or selected Source Branch.
7. For a public Source Repository, the queue worker requests a clone without credentials. For a private Source Repository, it mints a short-lived, repository-scoped, Contents-read installation token and passes it separately from the Agent Prompt to the agent microVM.
8. The microVM creates a shallow Repository Checkout of the selected Source Branch, or the repository default branch when none was selected, and fetches the exact commit for every offered Publication Option. Authentication is supplied only to these Git processes; it is absent from the clone URL and repository configuration and unavailable to OpenCode.
9. Before editing, the coding agent selects one offered Publication Option. The harness discards any selection-phase workspace changes and resets the checkout to that option's exact head commit.
10. The queue worker records the running microVM's non-secret identifier, endpoint, and current persisted-event sequence on the Agent Run. An attached CLI mints a short-lived token directly from AWS and subscribes after the corresponding microVM sequence.
11. OpenCode performs the task with its normal coding tools and no GitHub credential. The microVM emits ordered, replayable events to both the queue worker and any attached CLI. The worker persists bounded log events as the durable fallback; the CLI displays the live copy and advances its persisted-event cursor so those copies are not printed twice.
12. OpenCode's structured completion contains the textual response and either a request to publish through the selected option or a decision not to publish. When publication is requested, the microVM captures at most 250 changed paths and 3 MiB of regular-file, executable-file, and symlink content relative to the selected head. Paths, modes, content, and total size are bounded again by the queue worker.
13. The microVM emits one terminal completion event containing the textual response and untrusted change set. The CLI prints that response directly. The queue worker consumes the same event, terminates the microVM, and revokes the checkout token. The CLI then returns to DynamoDB because publication happens after microVM termination; the persisted terminal response is used as fallback and is not printed again after successful direct delivery.
14. The queue worker verifies that the Publication Decision names an option actually offered to this run, re-fetches its current GitHub state, and rejects an existing pull request whose head moved.
15. The queue worker mints a new single-repository installation token with Contents and Pull requests write permissions. It creates Git blobs, a tree, and one commit through GitHub's Git database endpoints.
16. A new-PR option creates `fireclanker/<agent-run-id>` and a draft pull request targeting the selected Source Branch or repository default branch. An existing-PR option fast-forwards its Fireclanker branch without force and does not create another pull request.
17. The queue worker revokes the publication token, records the publication URL in the event feed and textual result, then marks the Agent Run `succeeded`.
18. If execution or publication fails while the worker can still write, it stores a sanitized failure description and marks the run `failed`.

The Repository Checkout and files created in the Run Workspace are ephemeral execution aids. They are not retained as results or retrievable artifacts. The Execution Record is operational data and has no MVP CLI retrieval command; it can be accessed through S3 and AWS tooling.

GitHub credentials are transport secrets rather than Agent Run data. App private keys and installation tokens must never be stored in DynamoDB, included in an Agent Prompt or clone URL, intentionally exposed to OpenCode, or emitted in events, results, failure descriptions, and logs. Only the queue worker role may decrypt the deployment's GitHub App SSM parameter and mint installation tokens; the agent microVM execution role cannot. The microVM receives only the per-run read token needed for checkout, removes its access before OpenCode starts, and never receives the publication token.

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

Agent Run Events are the durable watch fallback, not the canonical complete execution history. A running Agent Run may also carry the current microVM identifier, endpoint, and the persisted-event sequence immediately before microVM events; these are non-secret attachment metadata. After observing a terminal state, watch uses a strongly consistent event query to drain events committed before that terminal transition. The table includes an index that allows `list` to query Agent Run records in reverse creation order. The Agent Run store uses conditional updates for lifecycle transitions so a stream event cannot execute the same queued run twice.

Agent Runs, Agent Run Events, and Execution Records have no TTL or per-run delete operation in the MVP. Redeployment preserves them for the lifetime of the deployment.

## Lambda packaging

The worker is an arm64 ZIP Lambda. The deployment pins the `opencode-linux-arm64` package, includes it through Alchemy's package installation support, then copies the executable to `/tmp` and sets its executable permission before starting OpenCode. The worker points its home and XDG directories at per-run locations under Lambda's writable temporary storage.

The final deployment bundle must be checked against Lambda's 250 MiB uncompressed ZIP limit. OpenCode and the worker's runtime data must also fit the available temporary storage. Exceeding either limit requires revisiting the execution architecture rather than deploying an incomplete OpenCode runtime.

## Services and layers

A Service is a port and a Layer is an adapter. Service interfaces remain independent from concrete AWS and OpenCode implementations.

The Agent Run persistence Service exposes domain lifecycle operations such as `create`, `claim`, `attachMicrovm`, `succeed`, `fail`, `get`, and `list`, rather than generic record writes. It owns conditional transitions and atomic state-field invariants. `attachMicrovm` advertises observation metadata only on a running run and only once. `claim` reports an already-claimed or terminal run as an expected not-claimed outcome; storage and decoding problems remain errors.

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
