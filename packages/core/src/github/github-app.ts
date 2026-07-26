import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { Effect, Redacted, Schema } from "effect"
import { GitHubAppCreationError } from "./error.ts"

export interface CreateGitHubAppInput {
  readonly organization: string
  readonly name: string
  readonly homepageUrl: string
}

export interface GitHubAppCredentials {
  readonly appId: number
  readonly organization: string
  readonly slug: string
  readonly privateKey: Redacted.Redacted<string>
}

export interface GitHubAppCreatorDependencies {
  readonly state: () => string
  readonly launch: (registrationUrl: string) => Effect.Effect<void, unknown>
  readonly exchange: (manifestCode: string) => Effect.Effect<unknown, unknown>
}

interface RegistrationServer {
  readonly callback: Promise<string>
  readonly registrationUrl: string
  readonly server: Server
}

const ManifestResponse = Schema.Struct({
  id: Schema.Number,
  owner: Schema.Struct({
    login: Schema.String,
    type: Schema.String
  }),
  slug: Schema.String,
  pem: Schema.String
})

const escapeAttribute = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")

const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer"
} as const

const registrationPage = (
  input: CreateGitHubAppInput,
  callbackUrl: string,
  state: string
): string => {
  const manifest = {
    name: input.name.slice(0, 34),
    url: input.homepageUrl,
    description: "Runs Fireclanker agents against GitHub repositories and opens pull requests.",
    redirect_url: callbackUrl,
    hook_attributes: {
      url: input.homepageUrl,
      active: false
    },
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write"
    },
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false
  }
  const action = `https://github.com/organizations/${encodeURIComponent(input.organization)}/settings/apps/new?state=${encodeURIComponent(state)}`

  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Create Fireclanker GitHub App</title></head>
  <body>
    <p>Redirecting to GitHub to create this deployment's Fireclanker App...</p>
    <form id="manifest" action="${action}" method="post">
      <input type="hidden" name="manifest" value="${escapeAttribute(JSON.stringify(manifest))}">
      <button type="submit">Continue to GitHub</button>
    </form>
    <script>document.getElementById("manifest").submit()</script>
  </body>
</html>`
}

const startRegistrationServer = (
  input: CreateGitHubAppInput,
  state: string
): Promise<RegistrationServer> => new Promise((resolve, reject) => {
  let complete = false
  let resolveCallback: (code: string) => void
  const callback = new Promise<string>((callbackResolve) => {
    resolveCallback = callbackResolve
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method !== "GET") {
      response.writeHead(405, responseHeaders).end("Method not allowed")
      return
    }
    if (url.pathname === "/") {
      const address = server.address()
      if (address === null || typeof address === "string") {
        response.writeHead(500, responseHeaders).end("Registration server is unavailable")
        return
      }
      const callbackUrl = `http://127.0.0.1:${address.port}/callback`
      response.writeHead(200, responseHeaders).end(registrationPage(input, callbackUrl, state))
      return
    }
    if (url.pathname !== "/callback") {
      response.writeHead(404, responseHeaders).end("Not found")
      return
    }
    const code = url.searchParams.get("code")
    if (url.searchParams.get("state") !== state || !code) {
      response.writeHead(400, responseHeaders).end("Invalid GitHub App registration callback")
      return
    }
    if (complete) {
      response.writeHead(409, responseHeaders).end("GitHub App registration is already complete")
      return
    }
    complete = true
    response.writeHead(200, responseHeaders).end(
      "<p>GitHub App registration approved. Return to the Fireclanker deployment.</p>"
    )
    resolveCallback!(code)
  })

  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (address === null || typeof address === "string") {
      reject(new Error("GitHub App registration server has no TCP address"))
      return
    }
    resolve({
      callback,
      registrationUrl: `http://127.0.0.1:${address.port}/`,
      server
    })
  })
})

const launchBrowser = (url: string) => Effect.tryPromise({
  try: () => new Promise<void>((resolve, reject) => {
    const command = process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] }
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore"
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  }),
  catch: () => new GitHubAppCreationError({ operation: "launch-registration" })
})

const exchangeManifest = (code: string) => Effect.tryPromise({
  try: async (signal) => {
    const response = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "fireclanker",
          "x-github-api-version": "2022-11-28"
        }
      }
    )
    if (!response.ok) throw new Error("GitHub rejected the App manifest conversion")
    return await response.json()
  },
  catch: () => new GitHubAppCreationError({ operation: "exchange-manifest" })
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.mapError(() => new GitHubAppCreationError({ operation: "exchange-manifest" }))
)

const defaults: GitHubAppCreatorDependencies = {
  state: () => crypto.randomUUID(),
  launch: launchBrowser,
  exchange: exchangeManifest
}

export const makeGitHubAppCreator = (
  dependencies: Partial<GitHubAppCreatorDependencies> = {}
) => Effect.fn("GitHub.createApp")(function*(input: CreateGitHubAppInput) {
  const services = { ...defaults, ...dependencies }
  const state = yield* Effect.try({
    try: services.state,
    catch: () => new GitHubAppCreationError({ operation: "create-state" })
  })
  const registration = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startRegistrationServer(input, state),
      catch: () => new GitHubAppCreationError({ operation: "start-registration" })
    }),
    ({ server }) => Effect.sync(() => {
      server.close()
      server.closeAllConnections()
    })
  )
  yield* Effect.logInfo("Approve GitHub App creation in your browser", {
    registrationUrl: registration.registrationUrl
  })
  yield* services.launch(registration.registrationUrl).pipe(
    Effect.catch(() => Effect.logWarning(
      "Unable to open a browser automatically; open the registration URL manually"
    ))
  )
  const code = yield* Effect.tryPromise({
    try: () => registration.callback,
    catch: () => new GitHubAppCreationError({ operation: "receive-callback" })
  }).pipe(
    Effect.timeout("10 minutes"),
    Effect.mapError(() => new GitHubAppCreationError({ operation: "receive-callback" }))
  )
  const manifest = yield* services.exchange(code).pipe(
    Effect.mapError(() => new GitHubAppCreationError({ operation: "exchange-manifest" }))
  )
  const credentials = yield* Schema.decodeUnknownEffect(ManifestResponse)(manifest).pipe(
    Effect.mapError(() => new GitHubAppCreationError({ operation: "decode-credentials" }))
  )
  if (
    !Number.isInteger(credentials.id) ||
    credentials.id <= 0 ||
    credentials.owner.type !== "Organization" ||
    credentials.owner.login.toLowerCase() !== input.organization.toLowerCase() ||
    !credentials.slug ||
    !credentials.pem
  ) {
    return yield* Effect.fail(new GitHubAppCreationError({ operation: "decode-credentials" }))
  }

  return {
    appId: credentials.id,
    organization: credentials.owner.login,
    slug: credentials.slug,
    privateKey: Redacted.make(credentials.pem)
  } satisfies GitHubAppCredentials
}, Effect.scoped)

export const createApp = makeGitHubAppCreator()
