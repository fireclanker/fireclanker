# Remote OpenAI subscription authentication

Fireclanker can use the ChatGPT subscription already connected to the local
OpenCode CLI for remote agent runs.

## Configure

Authenticate OpenCode locally:

```sh
opencode providers login --provider openai
```

Choose `ChatGPT Pro/Plus`, then upload only the OpenAI OAuth credential to the
configured deployment's AWS account:

```sh
fireclanker auth
fireclanker deploy
```

When running from the workspace:

```sh
bun run --filter @fireclanker/cli start -- auth
bun run --filter @fireclanker/cli start -- deploy
```

`auth` reads `openai` from OpenCode's
`~/.local/share/opencode/auth.json` (or the equivalent `XDG_DATA_HOME` path)
and writes it to the SSM `SecureString` parameter:

```text
/fireclanker/<deployment-name>/openai-subscription
```

The credential is not written to Fireclanker's configuration, Alchemy state,
the container image, DynamoDB, prompts, logs, or results.

## Runtime flow

Remote runs use GPT-5.6 Sol when the subscription parameter exists. If it does
not exist, Fireclanker continues to use Claude Sonnet 4.6 on Bedrock.

Before each subscription-backed run, the queue worker:

1. decrypts the OAuth credential from SSM;
2. exchanges its refresh token with OpenAI;
3. immediately stores the rotated credential back in SSM;
4. passes only the new short-lived access token and account ID to the agent
   microVM.

The refresh token never enters the agent microVM. The short-lived access token
is installed into OpenCode through its local server interface and is not
included in the agent prompt or event stream.

Agent runs share one FIFO message group, so the queue presents only one run at
a time to the worker. This prevents two runs from attempting to rotate the same
OAuth refresh token simultaneously without reserving account-level Lambda
concurrency.

## Security and operations

Submitted prompts are trusted by the MVP. The agent can use normal shell and
network tools, so the short-lived access token should still be treated as
available to code running inside that microVM. Do not use this mode for
untrusted public prompts.

Do not commit or copy OpenCode's `auth.json` into this repository or its
container image. Run `fireclanker auth` again after signing out, changing
ChatGPT accounts, revoking the connection, or receiving an OAuth refresh
failure.

Destroying the Alchemy stack does not delete the out-of-band subscription
parameter. Remove it explicitly from SSM when the deployment should no longer
use the subscription.
