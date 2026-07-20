# Electron Source Updater

This module owns the custom Windows source-update pipeline. It never mutates a contributor checkout and never invokes a shell. All writable state is derived from `%LOCALAPPDATA%/OpenChamberUpdate`.

Packaged builds contain `resources/source-update/source-update-manifest.json` and a content-addressed Git bundle. `scripts/prepare-source-update.mjs` only emits those resources from a clean, linear topic stack. The manifest records both the exact merge-base used by the bundle and the exact `upstream/main` tracking SHA observed at build time.

`createSourceUpdater()` exposes five operations to Electron main:

- `check()` resolves the official `main` SHA with `git ls-remote`.
- `prepare({ expectedUpstreamSha, onProgress, signal })` verifies the bundle, fetches official source into an isolated staging repository, rebases with hooks, signing, editors, and credential prompts disabled, runs the fixed validation/build pipeline, and copies only a verified Windows installer into the updater-owned ready directory. Cancelling the signal terminates the active Windows process tree.
- `readPreparedUpdate()` returns sanitized metadata without exposing local paths.
- `scheduleInstallAndRelaunch({ expectedUpstreamSha })` re-verifies the ready installer, binds it to the pending upstream SHA, and launches one detached hidden PowerShell helper. The helper waits for Electron to exit, re-verifies the installer hash and size, installs silently, and visibly launches the configured OpenChamber executable.
- `consumeInstallResult()` consumes the bounded success or failure result written by the install helper so a failed installation can be shown after the existing app is relaunched.

Conflicts and validation failures abort the update, delete staging state, and persist a bounded sanitized report under the updater-owned reports directory. Each contender uses its own nonce-named lock; dead owners and stale heartbeats are reclaimed without deleting another owner's lock. Main sends the structured error/report payload only to the local renderer that requested the build. Absolute local paths, commands, environment variables, and arbitrary remote URLs must never cross IPC.

The fetched upstream source and this fork's packaged topic commits are executable, trusted build input. The updater isolates `HOME`, `USERPROFILE`, application-data, npm config, temporary, and cache directories below the staging run and passes only an environment allowlist. Proxy variables are available only to the network-dependent fetch, frozen install, and package build stages; tests, typechecks, and lint do not inherit them. Before installation it checks the exact Bun version and minimum Node.js version declared by the fetched root `package.json`.

`main-integration.mjs` owns the narrow Electron/renderer adapter. It keeps prepared state bound to the exact checked upstream SHA, owns cancellation for an active preparation, duplicates terminal progress in the IPC result so reports cannot race listener cleanup, and exposes only a safe relative report filename. `main.mjs` remains responsible only for selecting this controller instead of `electron-updater`, publishing progress, and quitting after the install helper has been scheduled.
