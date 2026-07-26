import { expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { makeGitHubAppCreator } from "../src/github/index.ts"

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
