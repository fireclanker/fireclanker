# Programmatic E2E testing for deploy → run

## Recommendation

Start with one separately invoked, real-AWS Bun test against a fixed,
serialized `fc-e2e` deployment:

1. provision its dedicated GitHub App credentials once;
2. deploy or update the real Fireclanker stack at the current `prod` stage;
3. obtain the stack outputs;
4. queue one real Agent Run and wait for its terminal state; and
5. assert the persisted result and lifecycle events.

This is the same shape Alchemy documents for integration testing: `Test.make`,
`beforeAll(deploy(Stack))`, `yield* stack` for outputs, live requests against the
deployed program, and optionally `afterAll(destroy(Stack))`. Fireclanker's
current retention model makes per-run destruction unsafe, so the first version
should deliberately keep and update its dedicated deployment. The documented
test command targets the integration file explicitly, so the cloud test need
not be part of the ordinary unit-test command. [Alchemy AWS tutorial, Part
3](https://alchemy.run/aws/tutorial/part-3/)

The target design is a unique deployment name and stage per execution with a
guarded ephemeral resource lifecycle and unconditional cleanup. That requires
the lifecycle changes described below; it should not be simulated with the
current production-retention stack.

For Fireclanker, the best first test is the application E2E, not a snapshot of
the deploy log:

```text
deploy real AWS resources
  → queue Agent Run
  → DynamoDB stream
  → SQS
  → queue-worker Lambda
  → Lambda microVM
  → OpenCode on Bedrock
  → persisted events/result
```

The deployed worker really follows this path: it claims a queued job, obtains
GitHub repository access, starts and connects to a microVM, streams the agent
response, optionally publishes, writes the terminal result, and terminates the
microVM in cleanup. [queue-worker.ts](../../packages/cli/src/infra/queue-worker.ts#L92)

## What Alchemy gives us

`Test.make({ providers: AWS.providers(), state: AWS.state(), stage })` supplies
Effect-aware Bun hooks plus programmatic `deploy` and `destroy`. `deploy(Stack)`
plans and applies the stack; wrapping it in `beforeAll` deploys once and returns
a lazy accessor whose value is the object returned by the stack.
`destroy(Stack)` applies an empty desired state. [Alchemy test
harness](https://alchemy.run/testing/test-harness/) [Alchemy AWS tutorial, Part
3](https://alchemy.run/aws/tutorial/part-3/)

Fireclanker's stack already returns the useful deployment descriptor:
`executionRecordsBucket`, `tableName`, `tableArn`, both queue identifiers, and
`tableStreamArn`. An E2E test can obtain these typed outputs rather than parsing
deploy logs. [stack.ts](../../packages/cli/src/infra/stack.ts#L31)

The harness defaults to stage `test`, and it allows a stage at `Test.make` or
per deploy/destroy call. Alchemy documents unique stages as the mechanism for
parallel CI runs: stages separate state and generated physical names, and
destroying one stage leaves other stages alone. Stage names must match
`[a-z0-9][-_a-z0-9]*`. [Alchemy AWS tutorial, Part
4](https://alchemy.run/aws/tutorial/part-4/) [Alchemy stages
guide](https://alchemy.run/environments/stages/)

Cloud endpoints and asynchronous workflows need bounded readiness polling.
Alchemy specifically warns that a fresh Lambda Function URL can initially
fail because of propagation and cold start, and recommends a bounded retry;
the same principle applies to waiting for an Agent Run to become terminal.
[Alchemy AWS tutorial, Part
3](https://alchemy.run/aws/tutorial/part-3/#add-http-assertions) [Alchemy
stack-testing guide](https://alchemy.run/testing/testing-a-stack/)

## Fireclanker gaps that must be handled

### 1. The current deploy API is configuration-file and process-environment driven

`deploy` reads `~/.config/fireclanker/config.json`, configures an Alchemy
profile, ensures GitHub App credentials, computes the microVM source hash, sets
`FIRECLANKER_NAME` and `FIRECLANKER_AGENT_SOURCE_HASH`, and invokes the stack at
the hardcoded `prod` stage. [deploy.ts](../../packages/cli/src/infra/deploy.ts#L37)
These values are consumed when infrastructure modules load:
`FIRECLANKER_NAME` is mandatory, while the source hash falls back to
`"development"` if it was not set before `agent-microvm.ts` loaded.
[constants.ts](../../packages/cli/src/infra/constants.ts#L1)
[agent-microvm.ts](../../packages/cli/src/infra/agent-microvm.ts#L45)

The clean seam is a programmatic deployment function or stack factory that
accepts a deployment descriptor, for example:

```ts
{
  name,
  stage,
  profile,
  lifecycle: "persistent" | "ephemeral"
}
```

The CLI can keep reading its file and call that seam with `lifecycle:
"persistent"`; the E2E test can call the same seam with a unique name/stage and
`lifecycle: "ephemeral"`. The existing source-hash calculation must remain in
that shared path because it is passed into the agent microVM build.
[deploy.ts](../../packages/cli/src/infra/deploy.ts#L47)
[agent-microvm.ts](../../packages/cli/src/infra/agent-microvm.ts#L45)

This refactor is preferable to importing `stack.ts` after mutating global
environment variables in a test: it makes the test identity explicit and
prevents module-cache order from selecting the wrong deployment.

### 2. A unique Alchemy stage alone does not isolate this stack

Alchemy can stage-prefix generated names, but Fireclanker explicitly sets the
DynamoDB physical `tableName` to `FIRECLANKER_NAME`, and `run` addresses that
same name directly. [table.ts](../../packages/cli/src/infra/table.ts#L35)
[run.ts](../../packages/cli/src/infra/run.ts#L19) The present deploy and destroy
paths also both force stage `prod`. [deploy.ts](../../packages/cli/src/infra/deploy.ts#L81)
[destroy.ts](../../packages/cli/src/infra/destroy.ts#L17)

Therefore each execution should use both:

- a unique deployment name, such as `fc-e2e-<run-id>-<attempt>`; and
- a unique valid Alchemy stage, such as `e2e-<run-id>-<attempt>`.

Use the exact same pair for deploy and destroy. In CI, fail closed if the
generated E2E identity is missing or does not start with the reserved E2E
prefix; never fall back to `prod`, a developer deployment, or a shared stage
before running cleanup. The unique-stage form follows Alchemy's documented
parallel-CI model, while the unique deployment name additionally isolates
Fireclanker's explicitly named resources. [Alchemy AWS tutorial, Part
4](https://alchemy.run/aws/tutorial/part-4/#stages-in-tests)

### 3. GitHub App registration is interactive unless a ready fixture exists

On first deploy, Fireclanker reserves
`/fireclanker/<deployment-name>/github-app`; if there is no ready value, it
starts GitHub's App creation flow. A ready parameter is reused when its
organization matches the deployment configuration. [github-app-credentials.ts](../../packages/cli/src/infra/github-app-credentials.ts#L107)

The E2E environment should own one pre-created GitHub App. It need not be
installed on the public read-only fixture repository; leaving it uninstalled
prevents the test Agent Run from receiving a publication target. Before an
ephemeral deployment, copy that App's ready credential envelope from the CI
secret store into the unique deployment's SSM path; after teardown, delete only
that copied SSM parameter, not the shared test App. This removes browser
interaction while exercising the same runtime credential read and
repository-access path. The worker reads the name-scoped ready parameter at
execution time. [github-app-credentials.ts](../../packages/cli/src/infra/github-app-credentials.ts#L61)
[queue-worker.ts](../../packages/cli/src/infra/queue-worker.ts#L92)

The secret value must not be printed or returned as a stack output. The current
stack does not output it, and the code represents the private key as a redacted
value after reading SSM. [github-app-credentials.ts](../../packages/cli/src/infra/github-app-credentials.ts#L74)

### 4. Production retention prevents ephemeral cleanup

The execution-records bucket is retained and has `forceDestroy: false`.
[stack.ts](../../packages/cli/src/infra/stack.ts#L21) The DynamoDB table has
deletion protection enabled and a retain removal policy.
[table.ts](../../packages/cli/src/infra/table.ts#L30) The GitHub App SSM
parameter is created outside the Alchemy stack, and the current `destroy`
implementation only runs Alchemy stack destruction.
[github-app-credentials.ts](../../packages/cli/src/infra/github-app-credentials.ts#L155)
[destroy.ts](../../packages/cli/src/infra/destroy.ts#L10)

Consequently, `afterAll(destroy(Stack))` by itself cannot make a uniquely named
Fireclanker test deployment disposable. The stack needs an explicit
E2E-only lifecycle option:

| Resource | Production | E2E |
| --- | --- | --- |
| DynamoDB table | retain; deletion protection on | delete; deletion protection off |
| execution-records bucket | retain; no forced emptying | delete; `forceDestroy` on |
| SSM GitHub App parameter | retain out of band | delete the per-run copy in fixture cleanup |
| GitHub App | retain | reuse the dedicated test App; do not create/delete per run |

Production must remain the default. The test should refuse `ephemeral`
lifecycle unless the deployment name has the reserved E2E prefix.

### Interim option: one fixed, serialized E2E deployment

If changing resource lifecycle is too large for the first increment, use one
fixed `fc-e2e` deployment at the current `prod` stage, provision its GitHub App
once, and serialize the dedicated E2E runner. Deploy updates that environment,
then the test queues a uniquely identified Agent Run and polls only that ID, so
old retained Agent Runs do not affect the assertion. The current `run` path
already returns the queued ID and its watcher fetches that exact record.
[run.ts](../../packages/cli/src/infra/run.ts#L28)
[agent-job-watch.ts](../../packages/cli/src/infra/agent-job-watch.ts#L70)

Do **not** call the generic stack `destroy` after each fixed-environment run:
Alchemy would remove the disposable resources and its desired state while the
retained, deletion-protected table, retained bucket, and out-of-band SSM/App
remain. That is not a clean ephemeral cycle and can make the following create
collide with retained physical resources. [stack.ts](../../packages/cli/src/infra/stack.ts#L21)
[table.ts](../../packages/cli/src/infra/table.ts#L30)
[destroy.ts](../../packages/cli/src/infra/destroy.ts#L10) [Alchemy apply
source](https://github.com/alchemy-run/alchemy/blob/68df27e377e2201cce08e8bd2144619b98eb8603/packages/alchemy/src/Apply.ts#L1653-L1663)

This fixed runner is the smallest useful first E2E and is compatible with
Fireclanker's intentional production retention, but it does not test
greenfield creation or teardown and cannot run concurrently. The unique
name/stage plus guarded ephemeral lifecycle remains the target design for
isolated parallel CI.

## Proposed test contract

Use a dedicated public fixture repository on which the test GitHub App is
deliberately **not** installed. This still exercises the App credential read,
GitHub installation lookup, anonymous public checkout, worker, microVM, and
Bedrock paths, while the lack of an installation means the worker offers no
publication target. Put a stable marker file in it and queue a read-only prompt
such as:

> Read `E2E_MARKER.txt`, do not modify any files, and include its contents in
> your final response.

The test should make assertions on durable application state, not on every
human-readable log line:

1. deployment completed and returned the expected `tableName`;
2. queueing returned an Agent Run ID;
3. bounded polling reached `succeeded` before the overall timeout;
4. the terminal result is non-empty and contains the fixture marker;
5. persisted events include the worker-claimed, microVM-running, and
   job-finished milestones; and
6. no publication was created for the read-only prompt.

`run` already queues through `AgentJobService`, prints the ID, and, with
`--watch`, waits for `succeeded` or fails the process for a failed Agent Run.
[run.ts](../../packages/cli/src/infra/run.ts#L28)
[agent-job-watch.ts](../../packages/cli/src/infra/agent-job-watch.ts#L70) The
worker persists stable milestone events around claiming, starting the microVM,
and finishing. [queue-worker.ts](../../packages/cli/src/infra/queue-worker.ts#L116)
[queue-worker.ts](../../packages/cli/src/infra/queue-worker.ts#L192)

There are two reasonable ways to drive the run:

- **Preferred first test:** invoke the programmatic Agent Job service against
  the deployed `tableName`, then poll the same service. This gives typed,
  durable assertions and isolates failures from terminal-output formatting.
- **Follow-up CLI acceptance test:** spawn
  `bun run src/index.ts run --watch --repo <fixture> <prompt>` with an isolated
  temporary `HOME` containing the unique E2E config, and assert its exit
  status. This proves the public CLI wiring as a thin extra layer. The CLI
  configuration path is explicitly under `HOME`, so a temporary home prevents
  the E2E suite from reading or modifying the operator's normal config.
  [config.ts](../../packages/cli/src/config.ts#L33)

Do not require exact model prose: the stable contract is terminal success plus
the marker, persisted milestones, and absence of publication. A strict
full-string assertion would make the infrastructure test depend on
non-contractual model wording.

## Lifecycle sketch

The following is architectural pseudocode, not an implementation:

```ts
const identity = requireSafeE2eIdentity(process.env.E2E_RUN_ID)

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: AWS.state(),
  profile: process.env.E2E_ALCHEMY_PROFILE,
  stage: identity.stage
})

const deployed = beforeAll(
  provisionReadyGitHubAppParameter(identity).pipe(
    Effect.andThen(deploy(makeFireclankerStack({
      name: identity.name,
      lifecycle: "ephemeral"
    })))
  ),
  { timeout: DEPLOY_TIMEOUT }
)

afterAll(
  destroy(makeFireclankerStack({
    name: identity.name,
    lifecycle: "ephemeral"
  })).pipe(
    Effect.ensuring(deletePerRunGitHubAppParameter(identity))
  ),
  { timeout: DESTROY_TIMEOUT }
)

test("deploys and completes an Agent Run", Effect.gen(function* () {
  const { tableName } = yield* deployed
  const job = yield* queueFixtureJob(tableName)
  const terminal = yield* pollTerminalJob(job.id, { bounded: true })
  assertE2eContract(terminal)
}), { timeout: RUN_TIMEOUT })
```

Alchemy's Bun hooks default to 120 seconds, and its docs show raising the
`beforeAll` timeout for slow cloud deployment. Fireclanker's worker itself
allows up to 540 seconds for a microVM and its Lambda timeout is ten minutes,
so deploy, run, and destroy need explicit, separate bounds above those values.
[Alchemy stack-testing guide](https://alchemy.run/testing/testing-a-stack/#deploy-once-with-beforeall)
[queue-worker.ts](../../packages/cli/src/infra/queue-worker.ts#L116)

An `afterAll` is appropriate for normal failures, but a killed CI process
cannot execute in-process cleanup. The CI job should therefore have an
independent always-run teardown step keyed by the same guarded identity, plus
a scheduled janitor for old `fc-e2e-*` resources as a final leak backstop. This
is an operational safeguard in addition to Alchemy's documented
`afterAll(destroy(Stack))` pattern. [Alchemy AWS tutorial, Part
3](https://alchemy.run/aws/tutorial/part-3/#destroy-after-tests-on-ci)

## Separate execution

Keep the file outside the normal unit-test glob, for example
`packages/cli/e2e/deploy-run.e2e.ts`, and add a dedicated command that
names it explicitly:

```text
bun test ./packages/cli/e2e/deploy-run.e2e.ts
```

Alchemy's tutorial likewise runs the deployed-stack test by naming its
integration file explicitly. [Alchemy AWS tutorial, Part
3](https://alchemy.run/aws/tutorial/part-3/#run-the-tests)

Expose it as a distinct `test:e2e` package/root script and a distinct,
single-concurrency CI job with its AWS and GitHub fixture secrets. Make the
ordinary test script explicitly target `packages/core/test` and
`packages/cli/test`, so it never discovers the E2E directory. Do not make that
ordinary script depend on `test:e2e`. A developer with the E2E credentials can
run the same command manually; CI can run it on demand, on a schedule, or on
selected changes without slowing every unit-test pass.

## Suggested delivery order

1. Provision one fixed `fc-e2e` GitHub App parameter and public fixture
   repository.
2. Extract the microVM source-hash calculation so the CLI and test deploy the
   same artifact.
3. Add the fixed, serialized Bun E2E test at stage `prod`; do not destroy it.
4. Add the separate `test:e2e` command and on-demand/scheduled CI job.
5. Then extract explicit stack/deploy inputs (`name`, `stage`, `profile`,
   lifecycle) while preserving the current CLI defaults.
6. Add the guarded ephemeral resource lifecycle, unique SSM parameter setup,
   independent CI teardown, and stale-resource janitor.
7. Optionally add the thin black-box CLI `run --watch` acceptance case.

This sequence delivers useful coverage without pretending the current retained
resources are disposable, then addresses every lifecycle blocker before
enabling unique parallel cloud deployments.
