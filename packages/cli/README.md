# Fireclanker CLI

Install dependencies from the workspace root:

```bash
bun install
```

Initialize the CLI and answer the prompts for deployment name, AWS region, and AWS profile:

```bash
bun run src/index.ts init
```

Authenticate SSO profiles before deploying:

```bash
aws sso login --profile <profile>
bun run src/index.ts deploy
```

`deploy`, `destroy`, and `run` require the configuration written by `init` at
`~/.config/fireclanker/config.json`.

`XDG_CONFIG_HOME` overrides the configuration root. When set, Fireclanker reads
and writes `$XDG_CONFIG_HOME/fireclanker/config.json`. This is useful for
automation that must keep the operator's normal Fireclanker configuration
untouched while continuing to use credentials under the normal home directory.

## End-to-end test

The separately invoked E2E test exercises the public CLI against real AWS
resources:

```text
fireclanker deploy
  -> fireclanker run --watch
  -> DynamoDB stream
  -> SQS
  -> queue-worker Lambda
  -> Lambda microVM
  -> OpenCode on Bedrock
  -> CLI result and lifecycle output
```

It uses one fixed, serialized deployment and intentionally does not destroy it.
The DynamoDB table, execution-record bucket, and GitHub App credentials use
production retention policies, so they are not safe to recreate under a fresh
name on every test run.

Prepare a public fixture repository containing `E2E_MARKER.txt`. The dedicated
E2E GitHub App should not be installed on this repository, which prevents the
Agent Run from receiving a publication target. Then set:

```bash
export FIRECLANKER_E2E_NAME=fc-e2e
export FIRECLANKER_E2E_AWS_REGION=us-east-1
export FIRECLANKER_E2E_AWS_PROFILE=sandbox-us
export FIRECLANKER_E2E_GITHUB_ORGANIZATION=fireclanker
export FIRECLANKER_E2E_REPOSITORY=fireclanker/e2e-fixture
export FIRECLANKER_E2E_MARKER='the exact contents of E2E_MARKER.txt'
```

The AWS profile must already authenticate non-interactively and have access to
the configured region, Bedrock model, and Lambda microVM APIs. Before the first
unattended or CI run, invoke the test once interactively and approve creation of
the dedicated `fc-e2e` GitHub App. Later deploys reuse its ready SSM parameter.
Do not install that App on the public fixture repository.

Run only the cloud test:

```bash
bun run test:e2e
```

The E2E filename deliberately does not match Bun's normal `.test`/`.spec`
discovery patterns, so ordinary `bun test` runs never discover it. CI must
serialize `test:e2e` executions for this fixed deployment.
