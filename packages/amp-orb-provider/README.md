# amp-orb-provider

Run [Amp](https://ampcode.com) [self-hosted orbs](https://ampcode.com/docs/orbs/self-hosted)
on CreateOS Sandboxes. One orb is one sandbox.

```
 Amp ──jobs over HTTPS──▶ amp orb provider ──runs──▶ dispatch.sh ──createos CLI──▶ sandbox
  ▲                         (your machine)                                         │
  └──────────────── amp orb bootstrap (runs inside the sandbox, as `user`) ────────┘
```

| Amp job  | What `dispatch.sh` does                                                                  |
| -------- | ---------------------------------------------------------------------------------------- |
| `spawn`  | Create the sandbox (or resume it if paused), set it up, start `amp orb bootstrap` in it. |
| `pause`  | `createos sandbox pause` — disk and memory are kept, compute stops.                      |
| `delete` | `createos sandbox rm --force`.                                                           |

Every job is safe to repeat. A job that arrives while an earlier one is still settling
(for example `spawn` while the sandbox is still `pausing`) waits for it to finish first.
Spawn also stops any `amp orb bootstrap` left over from before the pause, because
resume brings back the old processes.

## Requirements

On the machine that runs the provider:

- `amp`, `createos` (signed in, or `CREATEOS_API_KEY` set), `jq`, `bash`, and `sha256sum` or `shasum`.
- Outbound HTTPS to ampcode.com and to the CreateOS API. Nothing connects in.

## Set up

1. In Amp, open **Settings → Orbs** for your workspace, click **Add Orb Provider**, name it
   (for example `createos`), and copy the `aop_live_…` token. Amp shows it once.
2. Run the provider under a service manager that restarts it:

   ```sh
   chmod +x dispatch.sh
   export AMP_ORB_PROVIDER_TOKEN="aop_live_…"
   amp orb provider "$PWD/dispatch.sh"
   ```

3. Start a thread on it:

   ```sh
   amp -ox "your first message" --orb-provider createos
   ```

## Settings

| Variable             | Default       | Meaning                                                         |
| -------------------- | ------------- | --------------------------------------------------------------- |
| `CREATEOS_ORB_SHAPE` | `s-4vcpu-8gb` | Sandbox size. See `createos sandbox shapes`.                    |
| `CREATEOS_API_KEY`   | stored login  | CreateOS credential, read by the `createos` CLI for every job. |

## How it differs from Amp's examples

- **`ORB_IMAGE` is ignored.** CreateOS templates build only `FROM nodeops/sandbox:*`, so
  Amp's orb image cannot boot as-is. The sandbox boots `devbox:1` (Ubuntu 24.04, x64,
  with git, node, tmux, rg, curl) and the first spawn adds what the orb image contract
  needs: `sudo`, `gh`, a `user` account with passwordless sudo, and the `amp` binary at
  `/usr/local/bin/amp` (via Amp's checksum-verifying installer). This makes the first
  spawn slower: 16 s to 226 s in testing. Amp allows five minutes.
- **`ORB_SNAPSHOT_ID` is ignored**, which the contract allows. Each new thread boots fresh
  and runs `.agents/setup`. Pausing and resuming the same thread keeps its disk.
- **No Desktop tab.** `devbox:1` lacks the Wayland stack Amp's Desktop needs.
- **Sandbox names are hashed.** CreateOS caps names at 22 characters, so orb
  `amp-T-…` becomes sandbox `amp-<first 18 hex of sha256(ORB_ID)>`.
- **No egress allowlist.** Orbs need ampcode.com, your Git host, and more, and CreateOS
  does not enforce hostname egress rules.

## Test

`./test.sh` runs every job against live CreateOS with a fake `ORB_TOKEN`: create,
repeat, stale bootstrap cleanup, `AMP_URL` passthrough, pause, resume with disk and
memory kept, spawn during `pausing`, pause during `resuming`, delete. It creates one
sandbox and always deletes it. A fake token cannot test a real Amp thread; for that,
register a provider and start a thread.
