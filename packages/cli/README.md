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
