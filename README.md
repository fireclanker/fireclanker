# fireclanker

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

The real-AWS CLI end-to-end test is intentionally separate from ordinary Bun
test discovery:

```bash
bun run test:e2e
```

It requires a dedicated deployment, AWS profile, and public fixture repository.
See [`packages/cli/README.md`](packages/cli/README.md#end-to-end-test) for setup.

This project was created using `bun init` in bun v1.3.13. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
