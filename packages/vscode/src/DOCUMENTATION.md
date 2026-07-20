# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`pr-description`, `conflict-details`) and generation helpers.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution.

- `gitService.ts`
  - Owns VS Code Git and worktree operations.
  - Fast worktree creation reports bootstrap phases explicitly: `directory-created`, then `git-ready` after Git population/upstream work, and `setup-ready` after setup commands. Existing worktrees without tracked bootstrap state fall back to `ready`/`setup-ready`; shared webview consumers also accept legacy responses without `phase`.
  - Worktree removal waits for an active create/bootstrap task for the same directory so background Git and setup work cannot race deletion or restore stale bootstrap state.

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - dropped-file parsing and attachment reading
    - models metadata fetch helper

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).

- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.

- `bridge-system-runtime.ts`
  - System/editor/quota/notification/update-check message handlers and thin provider-instance delegation.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).

- `provider-instance-bridge-runtime.ts`
  - Implements provider-instance parity for create/update/source/delete requests. Canonical-provider creation fetches OpenCode's provider catalog with the current directory query. Generic `openai-compatible` creation instead performs a bounded, authenticated extension-host `GET <baseURL>/models` discovery before any write. Discovery follows the instance's direct, manual, Windows system/PAC, or macOS/Linux HTTP(S)_PROXY + NO_PROXY selection; the API key is passed to native helpers only over stdin and is never returned or logged. It rejects redirects, oversized or malformed catalogs, and unsafe model IDs, then persists only the authoritative model-ID snapshot. Compatible updates rediscover when their base URL, API key, or proxy changes; name-only updates stay offline, and discovery failure leaves config, auth, and proxy state untouched.
  - Provider creation persists alias config through `providerInstances.ts` and stores API-key auth under the exact alias through `opencodeAuth.ts`. Proxy changes restart managed OpenCode when possible so the generated plugin hook becomes active; persistence remains valid and retryable if restart is unavailable.
  - Provider source responses include only non-secret instance metadata, effective auth type, and proxy mode/URL. Canonical/OAuth providers always report direct routing; per-provider proxy fetch is restricted to managed API-key aliases because replacing a canonical provider's auth-loader fetch would break subscription token/header/endpoint behavior. Effective config `options.apiKey` takes precedence over any OAuth auth-file entry and avoids reading the auth file. Webview interception forwards the same validated request directory for source/create/update/delete so catalogs and config layers match the active OpenCode context.

- `opencodeConfig.ts`
  - Owns general VS Code-local OpenCode config layering and exposes the narrow storage adapter used by provider instances.

- `providerInstances.ts`
  - Owns VS Code-local provider-instance validation, metadata, model snapshots, and persistence.
  - Managed provider IDs use `<sourceProviderId>:openchamber:<uuid>` and canonical alias configs retain the canonical source via top-level `id`. Generic `openai-compatible` aliases deliberately omit `id`, select `@ai-sdk/openai-compatible` via top-level `npm`, require a safe base URL, and store minimal null-prototype `models[id] = { name: id }` snapshots.
  - Provider model snapshots omit runtime headers and copy only explicit static fields plus allowlisted non-secret options/variants. Model API URLs containing embedded credentials, fragments, or sensitive query parameters are omitted. Dynamic provider/model/variant map keys reject prototype-pollution names, and generated model/variant maps use null prototypes.
  - Optional provider base URLs must be HTTP(S), contain no embedded credentials or fragment, and contain no sensitive query-key name after separator/case normalization. Source metadata redacts unsafe pre-existing values to `null`.
  - Canonical provider updates without credential intent preserve both existing OAuth auth and any pre-existing config `options.apiKey`, while updating the effective custom/project/user config owner for the active directory. Canonical providers reject non-direct proxy settings and never create sidecar mappings. An explicit API key removes the config key, writes exact-ID auth, and rolls the config back if auth persistence fails. Explicit `credentialMode: "oauth"` removes only the config key while preserving name, base URL, unrelated options, and OAuth auth; managed aliases reject OAuth intent. Managed updates require an existing user-config alias, remain user-owned, and roll config plus proxy state back together on later credential-write failure.

- `providerProxy.ts`
  - Owns the shared `~/.config/openchamber/provider-proxies.json` sidecar contract and the auto-discovered `~/.config/opencode/plugins/openchamber-provider-proxy.js` hook used by web and VS Code runtimes for managed API-key aliases.
  - Stores only exact provider IDs and non-secret `system` or normalized manual HTTP(S)-origin settings; direct mode removes the mapping. Sidecar/plugin writes are private, same-directory atomic replacements with unsafe-target checks and rollback when plugin installation fails.
  - The generated plugin is byte-compatible with the web runtime's single named export. It injects Bun proxy fetch only for mapped exact provider IDs. Windows system mode resolves static settings and PAC through hidden `SystemWebProxy`; manual mode uses the configured origin.
  - Extension-host compatible-model discovery uses hidden PowerShell/.NET on Windows and curl-over-stdin on other platforms. Non-Windows system mode requires the matching HTTP_PROXY or HTTPS_PROXY environment setting and honors NO_PROXY; a missing system proxy fails explicitly.

- `opencodeAuth.ts`
  - Owns exact-ID provider auth reads/removal and API-key replacement in OpenCode's auth file.
  - Auth writes use a mode-`0600` same-directory temporary file and atomic rename, preserve a private mode-`0600` backup, and harden the data directory to mode `0700` on POSIX. POSIX permission failures abort safely (including removing an insecure backup); unsupported chmod failures are tolerated only on Windows. Failed writes clean temporary files and never log credential content.

- `bridge-permission-auto-accept-runtime.ts`
  - Owns the persisted VS Code permission auto-accept policy and its GET/PUT bridge contract.
  - Broadcasts policy snapshots to every active OpenChamber webview. Permission replies remain foreground UI-owned because VS Code does not run the OpenChamber server runtime.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.
