import { generateKeyPairSync } from "node:crypto"
import { expect, test } from "bun:test"
import { Effect, Redacted, Schema } from "effect"
import {
  AgentJobId,
  SourceBranch,
  SourceRepository
} from "../src/agent-job/agent-job.model.ts"
import {
  GitHubAppRepositoryAccess,
  GitHubRepositoryAccess,
  makeGitHubAppCreator
} from "../src/github/index.ts"

test("creates an organization-owned GitHub App from a manifest", async () => {
  let manifestPage = ""
  let exchangedCode = ""
  const createApp = makeGitHubAppCreator({
    state: () => "test-state",
    launch: (registrationUrl) => Effect.tryPromise(async () => {
      const registration = await fetch(registrationUrl)
      manifestPage = await registration.text()
      const callbackUrl = manifestPage.match(/redirect_url&quot;:&quot;([^&]+)&quot;/)?.[1]
      if (!callbackUrl) throw new Error("Manifest page has no callback URL")

      const invalid = await fetch(`${callbackUrl}?code=ignored&state=wrong-state`)
      expect(invalid.status).toBe(400)
      const callback = await fetch(`${callbackUrl}?code=manifest-code&state=test-state`)
      expect(callback.status).toBe(200)
    }),
    exchange: (code) => {
      exchangedCode = code
      return Effect.succeed({
        id: 12345,
        owner: {
          login: "Acme",
          type: "Organization"
        },
        slug: "fireclanker-acme",
        pem: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----"
      } as unknown)
    }
  })

  const app = await Effect.runPromise(createApp({
    organization: "acme",
    name: "Fireclanker production",
    homepageUrl: "https://github.com/fireclanker/fireclanker"
  }))

  expect(manifestPage).toContain("https://github.com/organizations/acme/settings/apps/new")
  expect(manifestPage).toContain("&quot;public&quot;:false")
  expect(manifestPage).toContain("&quot;contents&quot;:&quot;write&quot;")
  expect(manifestPage).toContain("&quot;pull_requests&quot;:&quot;write&quot;")
  expect(exchangedCode).toBe("manifest-code")
  expect(app.appId).toBe(12345)
  expect(app.organization).toBe("Acme")
  expect(app.slug).toBe("fireclanker-acme")
  expect(String(app.privateKey)).not.toContain("BEGIN RSA PRIVATE KEY")
  expect(Redacted.value(app.privateKey)).toContain("BEGIN RSA PRIVATE KEY")
})

const sourceRepository = Schema.decodeUnknownSync(SourceRepository)("Acme/private-repo")
const sourceBranch = Schema.decodeUnknownSync(SourceBranch)("release/next")
const jobId = Schema.decodeUnknownSync(AgentJobId)("12345678-1234-4234-8234-123456789abc")

const credentials = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return {
    appId: 12345,
    organization: "Acme",
    slug: "fireclanker-acme",
    privateKey: Redacted.make(privateKey.export({ type: "pkcs1", format: "pem" }).toString())
  }
}

test("uses anonymous checkout for a public Source Repository", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const layer = GitHubAppRepositoryAccess(credentials(), {
    now: () => Date.parse("2026-07-26T20:00:00.000Z"),
    request: async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response("{}", { status: 404 })
    }
  })

  const token = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.checkoutToken(sourceRepository)
  }).pipe(Effect.provide(layer)))

  expect(token).toBeUndefined()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    url: "https://api.github.com/repos/Acme/private-repo/installation",
    init: {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "fireclanker",
        "x-github-api-version": "2026-03-10"
      }
    }
  })
  expect(new Headers(requests[0]!.init?.headers).get("authorization"))
    .toStartWith("Bearer ")
})

test("does not expose a token when the App is installed on a public Source Repository", async () => {
  let requestCount = 0
  const layer = GitHubAppRepositoryAccess(credentials(), {
    now: () => Date.parse("2026-07-26T20:00:00.000Z"),
    request: async () => {
      requestCount++
      if (requestCount === 1) return Response.json({ id: 98765 })
      if (requestCount === 2) {
        return Response.json({ token: "ghs_checkout_token" }, { status: 201 })
      }
      if (requestCount === 3) return Response.json({ visibility: "public" })
      return new Response(null, { status: 204 })
    }
  })

  const token = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.checkoutToken(sourceRepository)
  }).pipe(Effect.provide(layer)))

  expect(token).toBeUndefined()
  expect(requestCount).toBe(4)
})

test("mints a repository-scoped checkout token for a private Source Repository", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const now = Date.parse("2026-07-26T20:00:00.000Z")
  const layer = GitHubAppRepositoryAccess(credentials(), {
    now: () => now,
    request: async (url, init) => {
      requests.push({ url: String(url), init })
      if (requests.length === 1) {
        return Response.json({ id: 98765 })
      }
      if (requests.length === 2) {
        return Response.json({ token: "ghs_checkout_token" }, { status: 201 })
      }
      return Response.json({ visibility: "private" })
    }
  })

  const token = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.checkoutToken(sourceRepository)
  }).pipe(Effect.provide(layer)))

  expect(String(token)).not.toContain("ghs_checkout_token")
  expect(Redacted.value(token!)).toBe("ghs_checkout_token")
  expect(requests.map(({ url }) => url)).toEqual([
    "https://api.github.com/repos/Acme/private-repo/installation",
    "https://api.github.com/app/installations/98765/access_tokens",
    "https://api.github.com/repos/Acme/private-repo"
  ])
  const authorization = new Headers(requests[0]!.init?.headers).get("authorization")
  expect(authorization).toStartWith("Bearer ")
  const jwt = authorization!.slice("Bearer ".length)
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString())
  expect(payload).toEqual({
    iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540,
    iss: "12345"
  })
  expect(requests[1]!.init?.method).toBe("POST")
  expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
    repositories: ["private-repo"],
    permissions: { contents: "read" }
  })
})

test("offers only a new PR and updates to Fireclanker-owned pull request branches", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const headSha = "1111111111111111111111111111111111111111"
  const defaultHeadSha = "3333333333333333333333333333333333333333"
  const layer = GitHubAppRepositoryAccess(credentials(), {
    request: async (url, init) => {
      requests.push({ url: String(url), init })
      switch (requests.length) {
        case 1:
          return Response.json({ id: 98765 })
        case 2:
          return Response.json({ token: "ghs_options_token" }, { status: 201 })
        case 3:
          return Response.json({ visibility: "private", default_branch: "main" })
        case 4:
          return Response.json({ object: { sha: defaultHeadSha } })
        case 5:
          return Response.json([
            {
              number: 7,
              title: "Fireclanker work",
              html_url: "https://github.com/Acme/private-repo/pull/7",
              head: {
                ref: "fireclanker/previous-run",
                sha: headSha,
                repo: { full_name: "Acme/private-repo" }
              }
            },
            {
              number: 8,
              title: "Human work",
              html_url: "https://github.com/Acme/private-repo/pull/8",
              head: {
                ref: "feature/human-work",
                sha: "2222222222222222222222222222222222222222",
                repo: { full_name: "Acme/private-repo" }
              }
            }
          ])
        case 6:
          return new Response(null, { status: 204 })
        default:
          throw new Error("Unexpected request")
      }
    }
  })

  const options = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.publicationOptions(sourceRepository, jobId, sourceBranch)
  }).pipe(Effect.provide(layer)))

  expect(options).toEqual([
    {
      id: "create-pull-request",
      kind: "create-pull-request",
      baseBranch: "release/next",
      branch: `fireclanker/${jobId}`,
      expectedHeadSha: defaultHeadSha
    },
    {
      id: `update-pull-request:7:${headSha}`,
      kind: "update-pull-request",
      pullRequestNumber: 7,
      title: "Fireclanker work",
      branch: "fireclanker/previous-run",
      expectedHeadSha: headSha
    }
  ])
  expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
    repositories: ["private-repo"],
    permissions: { contents: "read", pull_requests: "read" }
  })
  expect(requests[3]?.url).toBe(
    "https://api.github.com/repos/Acme/private-repo/git/ref/heads/release/next"
  )
  expect(requests.at(-1)).toMatchObject({
    url: "https://api.github.com/installation/token",
    init: { method: "DELETE" }
  })
})

test("offers no publication capability when the GitHub App is not installed", async () => {
  const layer = GitHubAppRepositoryAccess(credentials(), {
    request: async () => new Response("{}", { status: 404 })
  })

  const options = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.publicationOptions(sourceRepository, jobId)
  }).pipe(Effect.provide(layer)))

  expect(options).toEqual([])
})

test("publishes an agent-selected new draft pull request through GitHub's object API", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const treeSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  const blobSha = "cccccccccccccccccccccccccccccccccccccccc"
  const nextTreeSha = "dddddddddddddddddddddddddddddddddddddddd"
  const commitSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  const layer = GitHubAppRepositoryAccess(credentials(), {
    request: async (url, init) => {
      requests.push({ url: String(url), init })
      const path = String(url)
      if (requests.length === 1) return Response.json({ id: 98765 })
      if (requests.length === 2) {
        return Response.json({ token: "ghs_publish_token" }, { status: 201 })
      }
      if (path.endsWith("/private-repo")) {
        return Response.json({ visibility: "private", default_branch: "main" })
      }
      if (path.endsWith("/git/ref/heads/release/next")) {
        return Response.json({ object: { sha: baseSha } })
      }
      if (path.includes("/pulls?")) return Response.json([])
      if (path.endsWith(`/git/commits/${baseSha}`)) {
        return Response.json({ tree: { sha: treeSha } })
      }
      if (path.endsWith("/git/blobs")) return Response.json({ sha: blobSha }, { status: 201 })
      if (path.endsWith("/git/trees")) {
        return Response.json({ sha: nextTreeSha }, { status: 201 })
      }
      if (path.endsWith("/git/commits")) {
        return Response.json({ sha: commitSha }, { status: 201 })
      }
      if (path.endsWith("/git/refs")) return Response.json({}, { status: 201 })
      if (path.endsWith("/pulls")) {
        return Response.json({
          number: 42,
          html_url: "https://github.com/Acme/private-repo/pull/42"
        }, { status: 201 })
      }
      if (path.endsWith("/installation/token")) return new Response(null, { status: 204 })
      throw new Error(`Unexpected request: ${path}`)
    }
  })

  const publication = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.publish({
      sourceRepository,
      sourceBranch,
      jobId,
      offeredOptionIds: ["create-pull-request"],
      baseSha,
      changes: [{
        kind: "upsert",
        path: "src/example.ts",
        mode: "100644",
        contentBase64: Buffer.from("export const answer = 42\n").toString("base64")
      }],
      decision: {
        kind: "publish",
        optionId: "create-pull-request",
        commitMessage: "Add the answer",
        pullRequestTitle: "Add the answer",
        pullRequestBody: "Created by Fireclanker."
      }
    })
  }).pipe(Effect.provide(layer)))

  expect(publication).toEqual({
    commitSha,
    branch: `fireclanker/${jobId}`,
    pullRequestNumber: 42,
    url: "https://github.com/Acme/private-repo/pull/42"
  })
  expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
    repositories: ["private-repo"],
    permissions: { contents: "write", pull_requests: "write" }
  })
  const createTree = requests.find(({ url }) => url.endsWith("/git/trees"))
  expect(JSON.parse(String(createTree!.init?.body))).toEqual({
    base_tree: treeSha,
    tree: [{
      path: "src/example.ts",
      mode: "100644",
      type: "blob",
      sha: blobSha
    }]
  })
  const createBranch = requests.find(({ url }) => url.endsWith("/git/refs"))
  expect(JSON.parse(String(createBranch!.init?.body))).toEqual({
    ref: `refs/heads/fireclanker/${jobId}`,
    sha: commitSha
  })
  const createPull = requests.find(({ url }) => url.endsWith("/pulls"))
  expect(JSON.parse(String(createPull!.init?.body))).toMatchObject({
    head: `fireclanker/${jobId}`,
    base: "release/next",
    draft: true
  })
  expect(requests.at(-1)?.url).toBe("https://api.github.com/installation/token")
})

test("fast-forwards the selected existing pull request branch without opening another PR", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const defaultSha = "1111111111111111111111111111111111111111"
  const headSha = "2222222222222222222222222222222222222222"
  const parentTreeSha = "3333333333333333333333333333333333333333"
  const nextTreeSha = "4444444444444444444444444444444444444444"
  const commitSha = "5555555555555555555555555555555555555555"
  const layer = GitHubAppRepositoryAccess(credentials(), {
    request: async (url, init) => {
      requests.push({ url: String(url), init })
      const path = String(url)
      if (path.endsWith("/installation")) return Response.json({ id: 98765 })
      if (path.includes("/access_tokens")) {
        return Response.json({ token: "ghs_publish_token" }, { status: 201 })
      }
      if (path.endsWith("/private-repo")) {
        return Response.json({ visibility: "private", default_branch: "main" })
      }
      if (path.endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { sha: defaultSha } })
      }
      if (path.includes("/pulls?")) {
        return Response.json([{
          number: 7,
          title: "Existing work",
          html_url: "https://github.com/Acme/private-repo/pull/7",
          head: {
            ref: "fireclanker/existing",
            sha: headSha,
            repo: { full_name: "Acme/private-repo" }
          }
        }])
      }
      if (path.endsWith(`/git/commits/${headSha}`)) {
        return Response.json({ tree: { sha: parentTreeSha } })
      }
      if (path.endsWith("/git/trees")) {
        return Response.json({ sha: nextTreeSha }, { status: 201 })
      }
      if (path.endsWith("/git/commits")) {
        return Response.json({ sha: commitSha }, { status: 201 })
      }
      if (path.includes("/git/refs/heads/")) return Response.json({})
      if (path.endsWith("/installation/token")) return new Response(null, { status: 204 })
      throw new Error(`Unexpected request: ${path}`)
    }
  })

  const publication = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.publish({
      sourceRepository,
      jobId,
      offeredOptionIds: [`update-pull-request:7:${headSha}`],
      baseSha: headSha,
      changes: [{ kind: "delete", path: "obsolete.txt" }],
      decision: {
        kind: "publish",
        optionId: `update-pull-request:7:${headSha}`,
        commitMessage: "Continue existing work"
      }
    })
  }).pipe(Effect.provide(layer)))

  expect(publication).toEqual({
    commitSha,
    branch: "fireclanker/existing",
    pullRequestNumber: 7,
    url: "https://github.com/Acme/private-repo/pull/7"
  })
  const updateBranch = requests.find(({ init }) => init?.method === "PATCH")
  expect(JSON.parse(String(updateBranch!.init?.body))).toEqual({
    sha: commitSha,
    force: false
  })
  expect(requests.filter(({ url }) => url.endsWith("/pulls"))).toHaveLength(0)
})

test("rejects a publication option that Lambda did not offer", async () => {
  let writeCount = 0
  const layer = GitHubAppRepositoryAccess(credentials(), {
    request: async (url, init) => {
      const path = String(url)
      if (path.endsWith("/installation")) return Response.json({ id: 98765 })
      if (path.includes("/access_tokens")) {
        return Response.json({ token: "ghs_publish_token" }, { status: 201 })
      }
      if (path.endsWith("/private-repo")) {
        return Response.json({ visibility: "private", default_branch: "main" })
      }
      if (path.endsWith("/git/ref/heads/main")) {
        return Response.json({
          object: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
        })
      }
      if (path.includes("/pulls?")) return Response.json([])
      if (path.endsWith("/installation/token")) return new Response(null, { status: 204 })
      if (init?.method === "POST" || init?.method === "PATCH") writeCount++
      throw new Error(`Unexpected request: ${path}`)
    }
  })

  const error = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.publish({
      sourceRepository,
      jobId,
      offeredOptionIds: [
        "update-pull-request:999:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ],
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      changes: [{
        kind: "delete",
        path: "README.md"
      }],
      decision: {
        kind: "publish",
        optionId: "update-pull-request:999:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commitMessage: "Unexpected update"
      }
    })
  }).pipe(Effect.provide(layer), Effect.flip))

  expect(error.operation).toBe("authorize-publication")
  expect(writeCount).toBe(0)
})
