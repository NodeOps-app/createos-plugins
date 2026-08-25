# CreateOS Sandbox for Orca

Run an [Orca](https://orca.dev) workspace on a disposable [CreateOS](https://createos.sh)
Sandbox microVM instead of your laptop.

Each workspace gets its own Firecracker microVM. Orca connects to it over SSH and
runs your coding agent there, so heavy installs, builds, and test runs stay off
your machine.

This package holds no code. It registers one Orca VM recipe that shells out to
the `createos` CLI for every lifecycle phase.

## Requirements

- The `createos` CLI, signed in — run `createos login`.
- `git` and `ssh` on `PATH`.
- Orca's Settings > Cloud VM turned on.
- **A git repository with a remote.** See [Project requirements](#project-requirements).

Check the first three with:

```
createos setup orca --doctor
```

## Install

Orca's plugin installer clones a whole repository and expects `orca-plugin.json`
at its root. This package lives in a subdirectory of a monorepo, so installing it
by git URL does not work yet. Use a local checkout instead:

1. Clone this repository.
2. In Orca, open Settings > Plugins > Dev Paths.
3. Add the path to `packages/orca-plugin`.
4. Approve the **CreateOS Sandbox** recipe when Orca asks.

Then create a workspace, open the **Run on** menu, and pick **CreateOS Sandbox**
under Per-Workspace Environment.

## Project requirements

This recipe uses Orca's `provisioned-root` checkout mode: the sandbox creates the
workspace checkout, and Orca then adopts it. To confirm that the checkout on the
sandbox is the same project as the one on your machine, Orca compares git remote
identities.

A repository with **no remote** gets an identity that is local to your machine and
can never match on another host. Workspace creation fails at the last step with:

```
Imported folder does not match the selected project identity.
```

Add a remote before using this recipe:

```
git remote add origin <your-repository-url>
```

A plain folder that is not a git repository cannot use this recipe either.

## What happens on create

1. `createos` provisions a microVM (default shape `s-4vcpu-8gb`, image `devbox:1`,
   which ships sshd, git, and Node.js).
2. It wires SSH through the CreateOS gateway and waits until `sshd` accepts
   connections.
3. It packs your working tree — tracked files plus untracked ones that
   `.gitignore` does not exclude — and uploads it.
4. It checks the tree out on a branch named after your workspace, at the commit
   Orca asked for.
5. It installs any coding agents you asked for (see below).

Your checkout is **pushed, not cloned**, so no git token ever reaches the sandbox
and private repositories work with no extra setup. Uncommitted edits come along
with it.

## What happens on destroy

The sandbox is destroyed and its `~/.ssh/config` entry is removed.

## Coding agents

Orca does not tell a recipe which agent a workspace uses, so the recipe cannot
infer it. Name the agents you want with `CREATEOS_AGENTS`. Nothing is installed by
default.

```
CREATEOS_AGENTS=claude,codex
```

Accepted names, and the binary each one installs:

| Name       | Binary         |
| ---------- | -------------- |
| `claude`   | `claude`       |
| `codex`    | `codex`        |
| `cursor`   | `cursor-agent` |
| `opencode` | `opencode`     |
| `pi`       | `pi`           |

Note that `cursor` installs `cursor-agent`, not `cursor`.

An agent already present on the image is skipped, so naming one that ships with
`devbox:1` costs nothing. An unknown name fails immediately, before any sandbox is
created.

Each agent is installed by running that vendor's own install script at provision
time. Those scripts are not pinned to a version and are not checksum-verified, so
a workspace gets whatever the vendor publishes that day and it can change without
notice. To control exactly what you get, build a custom image and point
`CREATEOS_ROOTFS` at it.

## Configuration

Set any of these as environment variables before creating a workspace:

| Variable                     | Default           | Purpose                                     |
| ---------------------------- | ----------------- | ------------------------------------------- |
| `CREATEOS_SHAPE`             | `s-4vcpu-8gb`     | Sandbox size                                |
| `CREATEOS_ROOTFS`            | `devbox:1`        | Sandbox image                               |
| `CREATEOS_PROJECT_ROOT`      | `/workspace/repo` | Where the checkout lands inside the sandbox |
| `CREATEOS_SSH_READY_TIMEOUT` | `180s`            | How long to wait for `sshd`                 |
| `CREATEOS_AGENTS`            | (none)            | Coding agents to install, comma-separated   |

## Limits

- **Suspend and resume are not supported.** SSH does not reliably come back after
  a sandbox resume, so this recipe declares neither phase. Every workspace is
  destroy-and-recreate.
- **Large repositories can fail to upload.** Uploads of roughly 400 MB and above
  can return a `503` partway through, which fails workspace creation. The size
  that matters is your working tree minus what `.gitignore` excludes, so a large
  `node_modules` or build directory is usually already excluded.
- **Installing by git URL does not work yet.** See [Install](#install).

## Troubleshooting

Orca shows `Couldn't create worktree` for any failure during creation. The real
reason is in the log panel below that message, and in the toast in the corner.

| What you see                                                    | Cause                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Imported folder does not match the selected project identity.` | The project has no git remote. See [Project requirements](#project-requirements). |
| `request failed with status 503` during upload                  | The working tree is too large. See [Limits](#limits).                             |
| `unknown agent "..."`                                           | A name in `CREATEOS_AGENTS` is not in the table above.                            |
| `cannot use ... as a branch name`                               | The workspace name is not a valid git branch name. Rename the workspace.          |

If a create fails, the recipe destroys the sandbox it made. When even that cleanup
fails, it prints the sandbox id and the exact command to remove it by hand. Check
for anything left behind with:

```
createos sandbox list
```
