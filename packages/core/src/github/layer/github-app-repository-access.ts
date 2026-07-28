import { sign } from "node:crypto"
import { Effect, Layer, Redacted, Schema } from "effect"
import type {
  AgentJobId,
  SourceBranch,
  SourceRepository
} from "../../agent-job/agent-job.model.ts"
import {
  type ChangeSet,
  CreatePullRequestOption,
  GitObjectId,
  MAX_PUBLICATION_BYTES,
  MAX_PUBLICATION_FILES,
  PublicationDecision,
  PublicationResult,
  type PublicationOption,
  UpdatePullRequestOption
} from "../../publication/publication.model.ts"
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

const RepositoryDetails = Schema.Struct({
  visibility: Schema.String,
  default_branch: Schema.String.check(Schema.isNonEmpty())
})

const PullRequest = Schema.Struct({
  number: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  title: Schema.String,
  html_url: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    sha: GitObjectId,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String }))
  })
})

const PullRequests = Schema.Array(PullRequest)
type PullRequest = typeof PullRequest.Type

const GitCommit = Schema.Struct({
  tree: Schema.Struct({ sha: GitObjectId })
})

const GitReference = Schema.Struct({
  object: Schema.Struct({ sha: GitObjectId })
})

const GitObject = Schema.Struct({ sha: GitObjectId })

const CreatedPullRequest = Schema.Struct({
  number: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  html_url: Schema.String
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

const requireOk = (
  operation: string,
  response: Response
) => response.ok
  ? Effect.succeed(response)
  : Effect.fail(new GitHubRepositoryAccessError({ operation }))

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

const splitRepository = (sourceRepository: SourceRepository) => {
  const [owner, repository] = sourceRepository.split("/") as [string, string]
  const repositoryUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
  return { owner, repository, repositoryUrl } as const
}

const encodeRef = (ref: string): string =>
  ref.split("/").map(encodeURIComponent).join("/")

const isSafePath = (path: string): boolean => {
  if (!path || path.startsWith("/") || path.includes("\0")) return false
  const segments = path.split("/")
  return segments.every((segment) =>
    segment !== "" && segment !== "." && segment !== ".." &&
    segment.toLowerCase() !== ".git"
  )
}

const validateChanges = (
  changes: ChangeSet
): Effect.Effect<void, GitHubRepositoryAccessError> => Effect.gen(function*() {
  if (changes.length === 0 || changes.length > MAX_PUBLICATION_FILES) {
    return yield* Effect.fail(new GitHubRepositoryAccessError({
      operation: "validate-publication"
    }))
  }
  const paths = new Set<string>()
  let totalBytes = 0
  for (const change of changes) {
    if (!isSafePath(change.path) || paths.has(change.path)) {
      return yield* Effect.fail(new GitHubRepositoryAccessError({
        operation: "validate-publication"
      }))
    }
    paths.add(change.path)
    if (change.kind === "upsert") {
      const decoded = Buffer.from(change.contentBase64, "base64")
      if (decoded.toString("base64") !== change.contentBase64) {
        return yield* Effect.fail(new GitHubRepositoryAccessError({
          operation: "validate-publication"
        }))
      }
      totalBytes += decoded.byteLength
      if (totalBytes > MAX_PUBLICATION_BYTES) {
        return yield* Effect.fail(new GitHubRepositoryAccessError({
          operation: "validate-publication"
        }))
      }
    }
  }
})

export const GitHubAppRepositoryAccess = (
  credentials: GitHubAppCredentials,
  dependencies: Partial<GitHubAppRepositoryAccessDependencies> = {}
) => {
  const services = { ...defaultDependencies, ...dependencies }

  const appHeaders = Effect.try({
    try: () => ({
      ...headers,
      authorization: `Bearer ${createAppJwt(credentials, services.now())}`
    }),
    catch: () => new GitHubRepositoryAccessError({ operation: "create-app-jwt" })
  })

  const resolveInstallation = Effect.fn("GitHubRepositoryAccess.resolveInstallation")(
    function*(sourceRepository: SourceRepository) {
      const { repositoryUrl } = splitRepository(sourceRepository)
      const authenticatedHeaders = yield* appHeaders
      const response = yield* request(
        services,
        "resolve-installation",
        `${repositoryUrl}/installation`,
        { headers: authenticatedHeaders }
      )
      if (response.status === 404) return undefined
      yield* requireOk("resolve-installation", response)
      return yield* decodeResponse("resolve-installation", Installation, response)
    }
  )

  const mintInstallationToken = Effect.fn("GitHubRepositoryAccess.mintInstallationToken")(
    function*(
      sourceRepository: SourceRepository,
      installationId: number,
      permissions: Record<string, "read" | "write">
    ) {
      const { repository } = splitRepository(sourceRepository)
      const authenticatedHeaders = yield* appHeaders
      const response = yield* request(
        services,
        "mint-installation-token",
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: { ...authenticatedHeaders, "content-type": "application/json" },
          body: JSON.stringify({ repositories: [repository], permissions })
        }
      )
      yield* requireOk("mint-installation-token", response)
      return yield* decodeResponse("mint-installation-token", InstallationToken, response)
    }
  )

  const mintToken = Effect.fn("GitHubRepositoryAccess.mintToken")(
    function*(
      sourceRepository: SourceRepository,
      permissions: Record<string, "read" | "write">
    ) {
      const installation = yield* resolveInstallation(sourceRepository)
      if (installation === undefined) {
        return yield* Effect.fail(new GitHubRepositoryAccessError({
          operation: "resolve-installation"
        }))
      }
      return yield* mintInstallationToken(
        sourceRepository,
        installation.id,
        permissions
      )
    }
  )

  const tokenHeaders = (token: string) => ({
    ...headers,
    authorization: `Bearer ${token}`
  })

  const revokeToken = (token: string) => request(
    services,
    "revoke-installation-token",
    "https://api.github.com/installation/token",
    { method: "DELETE", headers: tokenHeaders(token) }
  ).pipe(
    Effect.flatMap((response) => requireOk("revoke-installation-token", response)),
    Effect.asVoid,
    Effect.catch((cause) => Effect.logWarning("Unable to revoke GitHub installation token", {
      operation: cause.operation
    }))
  )

  const loadPublicationOptions = Effect.fn("GitHubRepositoryAccess.loadPublicationOptions")(
    function*(
      sourceRepository: SourceRepository,
      jobId: AgentJobId,
      token: string,
      sourceBranch?: SourceBranch
    ) {
      const { repositoryUrl } = splitRepository(sourceRepository)
      const authenticatedHeaders = tokenHeaders(token)
      const repositoryResponse = yield* request(
        services,
        "inspect-repository",
        repositoryUrl,
        { headers: authenticatedHeaders }
      ).pipe(Effect.flatMap((response) => requireOk("inspect-repository", response)))
      const repository = yield* decodeResponse(
        "inspect-repository",
        RepositoryDetails,
        repositoryResponse
      )
      const baseBranch = sourceBranch ?? repository.default_branch
      const baseRefResponse = yield* request(
        services,
        "read-source-branch",
        `${repositoryUrl}/git/ref/heads/${encodeRef(baseBranch)}`,
        { headers: authenticatedHeaders }
      ).pipe(Effect.flatMap((response) => requireOk("read-source-branch", response)))
      const baseRef = yield* decodeResponse(
        "read-source-branch",
        GitReference,
        baseRefResponse
      )
      const pullsResponse = yield* request(
        services,
        "list-pull-requests",
        `${repositoryUrl}/pulls?state=open&per_page=100`,
        { headers: authenticatedHeaders }
      ).pipe(Effect.flatMap((response) => requireOk("list-pull-requests", response)))
      const pulls = yield* decodeResponse("list-pull-requests", PullRequests, pullsResponse)
      const options: Array<PublicationOption> = [
        new CreatePullRequestOption({
          id: "create-pull-request",
          kind: "create-pull-request",
          baseBranch,
          branch: `fireclanker/${jobId}`,
          expectedHeadSha: baseRef.object.sha
        })
      ]
      const canonicalRepository = sourceRepository.toLowerCase()
      for (const pull of pulls) {
        if (
          pull.head.repo?.full_name.toLowerCase() !== canonicalRepository ||
          !pull.head.ref.startsWith("fireclanker/")
        ) continue
        options.push(new UpdatePullRequestOption({
          id: `update-pull-request:${pull.number}:${pull.head.sha}`,
          kind: "update-pull-request",
          pullRequestNumber: pull.number,
          title: pull.title || `Pull request #${pull.number}`,
          branch: pull.head.ref,
          expectedHeadSha: pull.head.sha
        }))
      }
      return { options, pulls } as const
    }
  )

  const checkoutToken = Effect.fn("GitHubRepositoryAccess.checkoutToken")(
    function*(sourceRepository: SourceRepository) {
      const installation = yield* resolveInstallation(sourceRepository)
      if (installation === undefined) return undefined
      const { repository, repositoryUrl } = splitRepository(sourceRepository)
      const authenticatedHeaders = yield* appHeaders
      const tokenResponse = yield* request(
        services,
        "mint-installation-token",
        `https://api.github.com/app/installations/${installation.id}/access_tokens`,
        {
          method: "POST",
          headers: { ...authenticatedHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            repositories: [repository],
            permissions: { contents: "read" }
          })
        }
      )
      yield* requireOk("mint-installation-token", tokenResponse)
      const token = yield* decodeResponse(
        "mint-installation-token",
        InstallationToken,
        tokenResponse
      )
      const visibilityResponse = yield* request(
        services,
        "inspect-repository",
        repositoryUrl,
        { headers: tokenHeaders(token.token) }
      ).pipe(Effect.flatMap((response) => requireOk("inspect-repository", response)))
      const visibility = yield* decodeResponse(
        "inspect-repository",
        Schema.Struct({ visibility: Schema.String }),
        visibilityResponse
      )
      if (visibility.visibility === "public") {
        yield* revokeToken(token.token)
        return undefined
      }
      return Redacted.make(token.token)
    }
  )

  const publicationOptions = Effect.fn("GitHubRepositoryAccess.publicationOptions")(
    function*(
      sourceRepository: SourceRepository,
      jobId: AgentJobId,
      sourceBranch?: SourceBranch
    ) {
      const installation = yield* resolveInstallation(sourceRepository)
      if (installation === undefined) return []
      const token = yield* mintInstallationToken(sourceRepository, installation.id, {
        contents: "read",
        pull_requests: "read"
      })
      return yield* loadPublicationOptions(
        sourceRepository,
        jobId,
        token.token,
        sourceBranch
      ).pipe(
        Effect.map(({ options }) => options),
        Effect.ensuring(revokeToken(token.token))
      )
    }
  )

  const publish = Effect.fn("GitHubRepositoryAccess.publish")(
    function*(input: {
      readonly sourceRepository: SourceRepository
      readonly sourceBranch?: SourceBranch
      readonly jobId: AgentJobId
      readonly offeredOptionIds: ReadonlyArray<string>
      readonly baseSha: string
      readonly changes: ChangeSet
      readonly decision: typeof PublicationDecision.Type
    }) {
      if (input.decision.kind === "do-not-publish") return undefined
      const decision = input.decision
      if (!input.offeredOptionIds.includes(decision.optionId)) {
        return yield* Effect.fail(new GitHubRepositoryAccessError({
          operation: "authorize-publication"
        }))
      }
      yield* validateChanges(input.changes)
      const baseSha = yield* Schema.decodeUnknownEffect(GitObjectId)(input.baseSha).pipe(
        Effect.mapError(() => new GitHubRepositoryAccessError({
          operation: "validate-publication"
        }))
      )
      const token = yield* mintToken(input.sourceRepository, {
        contents: "write",
        pull_requests: "write"
      })
      return yield* Effect.gen(function*() {
        const { repositoryUrl } = splitRepository(input.sourceRepository)
        const authenticatedHeaders = tokenHeaders(token.token)
        const { options, pulls } = yield* loadPublicationOptions(
          input.sourceRepository,
          input.jobId,
          token.token,
          input.sourceBranch
        )
        const option = options.find((candidate) =>
          candidate.id === decision.optionId
        )
        if (option === undefined) {
          return yield* Effect.fail(new GitHubRepositoryAccessError({
            operation: "authorize-publication"
          }))
        }
        if (baseSha !== option.expectedHeadSha) {
          return yield* Effect.fail(new GitHubRepositoryAccessError({
            operation: "authorize-publication"
          }))
        }
        const parentSha = option.expectedHeadSha
        const parentResponse = yield* request(
          services,
          "read-parent-commit",
          `${repositoryUrl}/git/commits/${parentSha}`,
          { headers: authenticatedHeaders }
        ).pipe(Effect.flatMap((response) => requireOk("read-parent-commit", response)))
        const parent = yield* decodeResponse("read-parent-commit", GitCommit, parentResponse)

        const treeEntries = yield* Effect.forEach(input.changes, (change) =>
          Effect.gen(function*() {
            if (change.kind === "delete") {
              return { path: change.path, sha: null }
            }
            const blobResponse = yield* request(
              services,
              "create-blob",
              `${repositoryUrl}/git/blobs`,
              {
                method: "POST",
                headers: { ...authenticatedHeaders, "content-type": "application/json" },
                body: JSON.stringify({
                  content: change.contentBase64,
                  encoding: "base64"
                })
              }
            ).pipe(Effect.flatMap((response) => requireOk("create-blob", response)))
            const blob = yield* decodeResponse("create-blob", GitObject, blobResponse)
            return {
              path: change.path,
              mode: change.mode,
              type: "blob",
              sha: blob.sha
            }
          }), { concurrency: 8 })

        const treeResponse = yield* request(
          services,
          "create-tree",
          `${repositoryUrl}/git/trees`,
          {
            method: "POST",
            headers: { ...authenticatedHeaders, "content-type": "application/json" },
            body: JSON.stringify({
              base_tree: parent.tree.sha,
              tree: treeEntries
            })
          }
        ).pipe(Effect.flatMap((response) => requireOk("create-tree", response)))
        const tree = yield* decodeResponse("create-tree", GitObject, treeResponse)
        const commitResponse = yield* request(
          services,
          "create-commit",
          `${repositoryUrl}/git/commits`,
          {
            method: "POST",
            headers: { ...authenticatedHeaders, "content-type": "application/json" },
            body: JSON.stringify({
              message: decision.commitMessage,
              tree: tree.sha,
              parents: [parentSha]
            })
          }
        ).pipe(Effect.flatMap((response) => requireOk("create-commit", response)))
        const commit = yield* decodeResponse("create-commit", GitObject, commitResponse)

        if (option.kind === "create-pull-request") {
          yield* request(
            services,
            "create-branch",
            `${repositoryUrl}/git/refs`,
            {
              method: "POST",
              headers: { ...authenticatedHeaders, "content-type": "application/json" },
              body: JSON.stringify({
                ref: `refs/heads/${option.branch}`,
                sha: commit.sha
              })
            }
          ).pipe(Effect.flatMap((response) => requireOk("create-branch", response)))
          const pullResponse = yield* request(
            services,
            "create-pull-request",
            `${repositoryUrl}/pulls`,
            {
              method: "POST",
              headers: { ...authenticatedHeaders, "content-type": "application/json" },
              body: JSON.stringify({
                title: decision.pullRequestTitle ??
                  decision.commitMessage.split("\n", 1)[0],
                body: decision.pullRequestBody ?? "",
                head: option.branch,
                base: option.baseBranch,
                draft: true
              })
            }
          ).pipe(Effect.flatMap((response) => requireOk("create-pull-request", response)))
          const pull = yield* decodeResponse(
            "create-pull-request",
            CreatedPullRequest,
            pullResponse
          )
          return new PublicationResult({
            commitSha: commit.sha,
            branch: option.branch,
            pullRequestNumber: pull.number,
            url: pull.html_url
          })
        }

        yield* request(
          services,
          "update-branch",
          `${repositoryUrl}/git/refs/heads/${encodeRef(option.branch)}`,
          {
            method: "PATCH",
            headers: { ...authenticatedHeaders, "content-type": "application/json" },
            body: JSON.stringify({ sha: commit.sha, force: false })
          }
        ).pipe(Effect.flatMap((response) => requireOk("update-branch", response)))
        const pull = pulls.find((candidate) =>
          candidate.number === option.pullRequestNumber
        )
        if (pull === undefined) {
          return yield* Effect.fail(new GitHubRepositoryAccessError({
            operation: "authorize-publication"
          }))
        }
        return new PublicationResult({
          commitSha: commit.sha,
          branch: option.branch,
          pullRequestNumber: pull.number,
          url: pull.html_url
        })
      }).pipe(Effect.ensuring(revokeToken(token.token)))
    }
  )

  return Layer.succeed(
    GitHubRepositoryAccess,
    GitHubRepositoryAccess.of({
      checkoutToken,
      revokeToken: (token) => revokeToken(Redacted.value(token)),
      publicationOptions,
      publish
    })
  )
}
