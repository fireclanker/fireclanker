import { sign } from "node:crypto"
import { Effect, Layer, Redacted, Schema } from "effect"
import type { SourceRepository } from "../../agent-job/agent-job.model.ts"
import { GitHubRepositoryAccessError } from "../error.ts"
import type { GitHubAppCredentials } from "../github-app.ts"
import { GitHubRepositoryAccess } from "../service/github-repository-access.service.ts"

export interface GitHubAppRepositoryAccessDependencies {
  readonly now: () => number
  readonly request: (url: string | URL, init?: RequestInit) => Promise<Response>
}

const Installation = Schema.Struct({
  id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
})

const InstallationToken = Schema.Struct({
  token: Schema.String.check(Schema.isNonEmpty())
})

const RepositoryVisibility = Schema.Struct({
  visibility: Schema.String
})

const defaultDependencies: GitHubAppRepositoryAccessDependencies = {
  now: Date.now,
  request: fetch
}

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "fireclanker",
  "x-github-api-version": "2026-03-10"
} as const

const request = (
  dependencies: GitHubAppRepositoryAccessDependencies,
  operation: string,
  url: string,
  init?: RequestInit
) => Effect.tryPromise({
  try: (signal) => dependencies.request(url, { ...init, signal }),
  catch: () => new GitHubRepositoryAccessError({ operation })
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.mapError(() => new GitHubRepositoryAccessError({ operation }))
)

const decodeResponse = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown, never, never>,
  response: Response
) => Effect.tryPromise({
  try: () => response.json(),
  catch: () => new GitHubRepositoryAccessError({ operation })
}).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  Effect.mapError(() => new GitHubRepositoryAccessError({ operation }))
)

const createAppJwt = (
  credentials: GitHubAppCredentials,
  now: number
): string => {
  const base64url = (value: string | Uint8Array): string =>
    Buffer.from(value).toString("base64url")
  const seconds = Math.floor(now / 1000)
  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: String(credentials.appId)
    }))
  ].join(".")
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    Redacted.value(credentials.privateKey)
  ).toString("base64url")
  return `${unsigned}.${signature}`
}

export const GitHubAppRepositoryAccess = (
  credentials: GitHubAppCredentials,
  dependencies: Partial<GitHubAppRepositoryAccessDependencies> = {}
) => {
  const services = { ...defaultDependencies, ...dependencies }
  const checkoutToken = Effect.fn("GitHubRepositoryAccess.checkoutToken")(
    function*(sourceRepository: SourceRepository) {
      const [owner, repository] = sourceRepository.split("/") as [string, string]
      const repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
      const jwt = yield* Effect.try({
        try: () => createAppJwt(credentials, services.now()),
        catch: () => new GitHubRepositoryAccessError({ operation: "create-app-jwt" })
      })
      const authenticatedHeaders = {
        ...headers,
        authorization: `Bearer ${jwt}`
      }
      const installationResponse = yield* request(
        services,
        "resolve-installation",
        `${repositoryUrl}/installation`,
        { headers: authenticatedHeaders }
      )
      if (installationResponse.status === 404) return undefined
      if (!installationResponse.ok) {
        return yield* Effect.fail(new GitHubRepositoryAccessError({
          operation: "resolve-installation"
        }))
      }
      const installation = yield* decodeResponse(
        "resolve-installation",
        Installation,
        installationResponse
      )

      const tokenResponse = yield* request(
        services,
        "mint-installation-token",
        `https://api.github.com/app/installations/${installation.id}/access_tokens`,
        {
          method: "POST",
          headers: {
            ...authenticatedHeaders,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            repositories: [repository],
            permissions: { contents: "read" }
          })
        }
      )
      if (tokenResponse.status !== 201) {
        return yield* Effect.fail(new GitHubRepositoryAccessError({
          operation: "mint-installation-token"
        }))
      }
      const token = yield* decodeResponse(
        "mint-installation-token",
        InstallationToken,
        tokenResponse
      )
      const visibilityResponse = yield* request(
        services,
        "inspect-repository",
        repositoryUrl,
        {
          headers: {
            ...headers,
            authorization: `Bearer ${token.token}`
          }
        }
      )
      if (!visibilityResponse.ok) {
        return yield* Effect.fail(new GitHubRepositoryAccessError({
          operation: "inspect-repository"
        }))
      }
      const visibility = yield* decodeResponse(
        "inspect-repository",
        RepositoryVisibility,
        visibilityResponse
      )
      if (visibility.visibility === "public") return undefined
      return Redacted.make(token.token)
    }
  )

  return Layer.succeed(GitHubRepositoryAccess, GitHubRepositoryAccess.of({ checkoutToken }))
}
