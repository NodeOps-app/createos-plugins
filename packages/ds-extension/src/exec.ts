/**
 * Shared execution primitives for the CreateOS providers.
 *
 * Two CreateOS control-plane facts shape everything here:
 *
 * 1. `POST /v1/sandboxes/{id}/exec` takes `{cmd, args}` only — there is no
 *    per-call working directory, and its `env` map is an allowlist fixed at
 *    sandbox-create time (an undeclared key is a 400). Both are therefore
 *    carried in argv through `/usr/bin/env`, which the control plane never
 *    inspects.
 * 2. Exec is request-scoped: the caller gets no pid and no signal channel. A
 *    spawn is instead branded with {@link SPAWN_MARKER_ENV}, which every
 *    descendant inherits, so a later exec can find the whole tree by scanning
 *    `/proc/*\/environ` — tree-scoped termination without a pidfile.
 *
 * @module @createos/dsh/exec
 */

import type { Sandbox } from "@nodeops-createos/sandbox";

/**
 * Environment name branding one spawn and every process it forks. Inherited
 * through the whole tree, which is what makes marker-based termination
 * tree-scoped rather than direct-child-scoped.
 */
export const SPAWN_MARKER_ENV = "DSH_CREATEOS_SPAWN" as const;

/** Result of a buffered control command. */
export interface ExecCapture {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Agent-level failure (the command could not be started at all). */
  error?: string;
}

/**
 * Run a fixed script with data supplied as positional parameters.
 *
 * The script text is always a constant in this package; caller data arrives as
 * `$1`, `$2`, ... so a path or filename can never be re-parsed as shell syntax.
 * @param sandbox - the shared sandbox handle.
 * @param script - constant `sh` program referencing its positional parameters.
 * @param args - values bound to `$1`, `$2`, ... in order.
 * @param signal - aborts the underlying HTTP request.
 * @returns the buffered streams and exit code; a non-zero exit is not an error here.
 */
export async function execScript(
  sandbox: Sandbox,
  script: string,
  args: readonly string[] = [],
  signal?: AbortSignal,
): Promise<ExecCapture> {
  // argv[0] after the script is $0, not $1 — bind it to a label so caller data starts at $1.
  const response = await sandbox.runCommand(
    "sh",
    ["-c", script, "dsh", ...args],
    signal === undefined ? {} : { signal },
  );
  const result = response.result;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exit_code ?? 0,
    ...(result.error !== undefined && result.error !== "" ? { error: result.error } : {}),
  };
}

/**
 * Run a fixed script and reject unless it exits zero.
 * @param sandbox - the shared sandbox handle.
 * @param script - constant `sh` program referencing its positional parameters.
 * @param args - values bound to `$1`, `$2`, ... in order.
 * @param signal - aborts the underlying HTTP request.
 * @returns the captured stdout.
 * @throws when the command could not start or exited non-zero.
 */
export async function execScriptChecked(
  sandbox: Sandbox,
  script: string,
  args: readonly string[] = [],
  signal?: AbortSignal,
): Promise<string> {
  const capture = await execScript(sandbox, script, args, signal);
  if (capture.error !== undefined) throw new Error(capture.error);
  if (capture.exitCode !== 0) {
    throw new Error(capture.stderr.trim() || `command exited ${capture.exitCode}`);
  }
  return capture.stdout;
}

/**
 * Build the argv that applies a working directory and environment to a spawn.
 *
 * `env -C` needs GNU coreutils >= 8.28 (Debian 10+, Ubuntu 18.04+), which every
 * CreateOS rootfs ships. The executable is always an absolute path resolved
 * beforehand, so it can never be mistaken for a `NAME=VALUE` assignment.
 * @param cwd - absolute working directory in the sandbox.
 * @param env - environment entries layered onto the sandbox's own; `undefined` values unset a name.
 * @param argv - the resolved executable followed by its arguments.
 * @returns the `cmd` and `args` to hand to the exec endpoint.
 */
export function envArgv(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
): { cmd: string; args: string[] } {
  const args = ["-C", cwd];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) args.push("-u", key);
    else args.push(`${key}=${value}`);
  }
  args.push(...argv);
  return { cmd: "env", args };
}

/**
 * `sh` program that redirects stdin from a staged file (or `/dev/null`) and then
 * becomes the target process. Used because the exec endpoint carries no stdin
 * stream — batch stdin is staged as a file first.
 *
 * `$1` is the stdin path (empty for none); `$2...` is the argv to exec.
 */
export const STDIN_WRAPPER = `s=$1
shift
if [ -n "$s" ]; then exec <"$s"; else exec </dev/null; fi
exec "$@"`;

/**
 * Locate every live process carrying a spawn marker and signal it.
 *
 * Reading `/proc/<pid>/environ` finds the complete tree because the marker is
 * inherited, so an orphaned grandchild that outlived its parent is still
 * reachable. The scan skips itself so the signalling shell never kills its own
 * exec.
 *
 * `$1` is the signal name; `$2` is the marker value.
 */
export const SIGNAL_TREE_SCRIPT = `sig=$1
want=$2
self=$$
for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  [ "$pid" = "$self" ] && continue
  tr '\\0' '\\n' <"$d/environ" 2>/dev/null | grep -qxF "${SPAWN_MARKER_ENV}=$want" || continue
  kill -"$sig" "$pid" 2>/dev/null
done
exit 0`;

/**
 * Report whether any process still carries the spawn marker.
 *
 * `$1` is the marker value. Prints `alive` or `gone`.
 */
export const TREE_ALIVE_SCRIPT = `want=$1
self=$$
for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  [ "$pid" = "$self" ] && continue
  if tr '\\0' '\\n' <"$d/environ" 2>/dev/null | grep -qxF "${SPAWN_MARKER_ENV}=$want"; then
    printf alive
    exit 0
  fi
done
printf gone`;
