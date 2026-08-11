# Pi Startup Sync Design

## Goal

Let a Pi session populate its CreateOS sandbox from the host project before the agent starts, either once or as a persistent two-way sync.

## Scope

- Add Pi-extension-only flags: `--sync-once` and `--watch`.
- The host source is the directory where Pi starts.
- The sandbox target is always `/root/workspace`.
- Do not add or change CreateOS CLI flags or commands.
- Add honest TUI progress: a cancellable phase loader for startup work and a persistent footer status for an active watcher.

## Behaviour

### `--sync-once`

1. Create and prepare the sandbox normally.
2. Validate the host project path and fixed target path.
3. Archive the host project, excluding VCS metadata (`.git`, `.hg`, `.svn`).
4. Upload the archive with the existing `createos sandbox push` command.
5. Extract it into `/root/workspace`, preserving existing sandbox-only files.
6. Remove both temporary archives.
7. Continue Pi startup only after the transfer completes.

### `--watch`

1. Create and prepare the sandbox normally.
2. Start the existing `createos sandbox sync` command in the background using its existing two-way Mutagen behaviour.
3. Store the spawned PID for session shutdown.
4. Stop that PID before removing the temporary SSH key or destroying the ephemeral sandbox.

The flags are mutually exclusive. Their startup work must fail the session setup clearly when a command fails. Pi must not silently fall back to operating on the host.

## UI

Pi can show a spinner but the existing CLI does not emit stable byte-progress events the extension can consume. `BorderedLoader` has no API for changing its message after construction, so it truthfully reports the overall operation only. This feature uses:

- `BorderedLoader` for blocking startup operations: "Syncing project to sandbox…" or "Starting project file watch…".
- Existing footer status for an active watcher: `☁ createos · <id> · sync watching`.

No percentage progress bar is shown until the CLI exposes machine-readable transfer progress.

## Safety

- All dynamically constructed shell commands use `shellQuote`.
- A one-time archive is constructed with argument arrays, not interpolation.
- `--sync-once` validates its host source and fixed target with the same conservative policy as the CLI: reject root, home, known credential directories, and sandbox system directories.
- `--watch` retains the CLI's existing path validation and VCS-ignore behaviour.

## Verification

- Unit tests cover startup-flag selection, safe archive arguments, and extraction command quoting.
- Package typecheck and Bun tests pass.
- Manual smoke path documents `pi --createos --sync-once` and `pi --createos --watch`.
