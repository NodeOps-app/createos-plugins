/**
 * First-run onboarding — the TypeScript twin of `cos setup`
 * (claude-code-plugin/scripts/cos). Installs the createos CLI, or upgrades it
 * in the background, then makes sure the user is signed in.
 *
 * `createos login` is a TTY select, so it runs in a detached tmux session with
 * "browser" picked: the user only finishes the OAuth page their browser opens.
 * A token file is no proof of sign-in (the CLI stores any pasted token
 * unvalidated), so `whoami` decides.
 *
 * Synced into pi-extension and opencode-plugin by scripts/sync-shared.sh.
 */
import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CLI_INSTALL_URL =
  "https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh";
const INSTALL = `curl -sfL ${CLI_INSTALL_URL} | sh -`;
const LOGIN_SESSION = "createos-login";
const PANE = `=${LOGIN_SESSION}:`;

export interface Onboarding {
  ready: boolean;
  /** For the agent's context. */
  status: string;
  /** Short line for a human-facing toast; absent when ready. */
  notice?: string;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 120_000) {
  return new Promise<{ ok: boolean; stdout: string }>((resolve) =>
    execFile(file, args, { env: { ...process.env, ...env }, timeout }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout) }),
    ),
  );
}

async function which(binary: string): Promise<string | undefined> {
  const res = await run("sh", ["-c", 'command -v -- "$1"', "sh", binary]);
  return res.ok ? res.stdout.trim() : undefined;
}

async function waitPane(pattern: RegExp): Promise<string | undefined> {
  for (let i = 0; i < 20; i++) {
    const { stdout } = await run("tmux", ["capture-pane", "-pJt", PANE]);
    if (pattern.test(stdout)) return stdout;
    await delay(500);
  }
  return undefined;
}

export async function onboard(binary = "createos"): Promise<Onboarding> {
  const local = join(homedir(), ".local/bin");
  if (!`:${process.env.PATH}:`.includes(`:${local}:`))
    process.env.PATH = `${local}:${process.env.PATH ?? ""}`;

  // Only the stock binary is ours to install; a custom path is the user's.
  const autoinstall = binary === "createos" && !process.env.COS_NO_AUTOINSTALL;
  let bin = await which(binary);
  if (bin && autoinstall) {
    // Upgrade into the binary's own dir, in the background: never blocks
    // startup, never needs sudo, never leaves a second copy shadowing the first.
    const dir = dirname(bin);
    if (
      await access(dir, constants.W_OK).then(
        () => true,
        () => false,
      )
    )
      spawn("sh", ["-c", INSTALL], {
        env: { ...process.env, CREATEOS_INSTALL_DIR: dir },
        detached: true,
        stdio: "ignore",
      }).unref();
  } else if (!bin && autoinstall) {
    await run("sh", ["-c", INSTALL]);
    bin = await which(binary);
  }
  if (!bin)
    return {
      ready: false,
      status: `createos CLI is NOT installed. Ask the user to install it: ${INSTALL}`,
      notice: `CreateOS CLI not installed. Install: ${INSTALL}`,
    };

  const version =
    (await run(bin, ["version"])).stdout.match(/Version:\s*(\S+)/)?.[1] ?? "(unknown version)";
  const head = `createos CLI ${version} is installed at ${bin}.`;
  if (process.env.CREATEOS_API_KEY)
    return { ready: true, status: `${head}\nSigned in via CREATEOS_API_KEY.` };
  if ((await run(bin, ["whoami"], undefined, 15_000)).ok)
    return { ready: true, status: `${head}\nSigned in to CreateOS.` };

  if (!(await which("tmux")))
    return {
      ready: false,
      status: `${head}\nNOT signed in to CreateOS. Ask the user to run \`createos login\` in their own terminal (browser or API token), or to export CREATEOS_API_KEY. Never ask for a token in chat.`,
      notice: "CreateOS: not signed in. Run `createos login` in a terminal.",
    };
  if (!(await run("tmux", ["has-session", "-t", `=${LOGIN_SESSION}`])).ok) {
    await run("tmux", [
      "new-session",
      "-d",
      "-s",
      LOGIN_SESSION,
      "-x",
      "250",
      "-y",
      "20",
      bin,
      "login",
    ]);
    if (await waitPane(/How would you like/)) {
      await run("tmux", ["send-keys", "-t", PANE, "-l", "browser"]);
      await delay(300);
      await run("tmux", ["send-keys", "-t", PANE, "Enter"]);
    }
  }
  // Headless hosts: the CLI can't launch a browser and exits, and its OAuth
  // callback is on this machine's localhost anyway — only a token works here.
  const pane = await waitPane(/Waiting for you|Could not open browser/);
  if (!pane || pane.includes("Could not open browser")) {
    await run("tmux", ["kill-session", "-t", `=${LOGIN_SESSION}`]);
    return {
      ready: false,
      status: `${head}\nNOT signed in to CreateOS, and no browser can be opened on this machine, so browser sign-in cannot finish here. Ask the user to run \`createos login\` in a terminal on this machine and pick "Sign in with API token", or to export CREATEOS_API_KEY. Never ask for a token in chat.`,
      notice: 'CreateOS: not signed in. Run `createos login` and pick "Sign in with API token".',
    };
  }
  const url = pane.match(/https:\/\/\S+/)?.[0];
  return {
    ready: false,
    status: [
      head,
      `NOT signed in to CreateOS. Started \`createos login\` in the hidden tmux session \`${LOGIN_SESSION}\` and picked browser sign-in; the user's default browser should now be on the CreateOS sign-in page.`,
      `Tell the user to finish signing in there${url ? ` (if no browser opened: ${url})` : ""}, then confirm with \`createos whoami\`. Sandbox work fails until then.`,
      `If they prefer an API token: \`tmux kill-session -t ${LOGIN_SESSION}\`, then have them run \`createos login\` in their own terminal and pick "Sign in with API token", or export CREATEOS_API_KEY. Never ask for a token in chat.`,
    ].join("\n"),
    notice: `CreateOS: finish signing in in your browser${url ? ` (or open ${url})` : ""}.`,
  };
}
