import { generateKeyPairSync } from "node:crypto"
import { expect, test } from "bun:test"
import { Effect, Redacted, Schema } from "effect"
import { SourceRepository } from "../src/agent-job/agent-job.model.ts"
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
      return Response.json({ visibility: "public" })
    }
  })

  const token = await Effect.runPromise(Effect.gen(function*() {
    const access = yield* GitHubRepositoryAccess
    return yield* access.checkoutToken(sourceRepository)
  }).pipe(Effect.provide(layer)))

  expect(token).toBeUndefined()
  expect(requestCount).toBe(3)
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
