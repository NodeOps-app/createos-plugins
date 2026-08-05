---
name: using-createos-sandbox
description: Use when the user wants to run code in a remote sandbox, offload heavy builds or tests, run untrusted code safely, create disposable Linux boxes, set up multi-node clusters, or use createos sandbox commands. Triggers on keywords like createos, sandbox, offload, remote, isolated, disposable box.
---

# Using CreateOS Sandbox as remote compute

A CreateOS Sandbox is an isolated Linux VM that goes from create to running your first command in roughly 200 ms. Use it as throwaway compute instead of running risky or heavy work on the user's laptop.

## The createos CLI

All sandbox operations use the `createos` CLI. Check it's available:

```bash
createos version
```

If not installed, install it:

```bash
curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh
```

Check auth:

```bash
createos sandbox shapes
```

If that fails, the user needs to run `createos login` in their own terminal (browser OAuth). **Never ask the user to paste an API key into the conversation.**

## When to use it

| Situation                 | Why                                            |
| ------------------------- | ---------------------------------------------- |
| Untrusted/unknown code    | Isolation — blast radius is one disposable box |
| Heavy build or test suite | Keeps the laptop free                          |
| Quick scratch Linux       | Instant clean box, destroyed when done         |
| Clean-room repro          | Fresh rootfs every time                        |
| Multi-machine setup       | Private network clusters                       |

## Core commands

### Create a sandbox

```bash
createos sandbox create --shape s-2vcpu-2gb --ingress
```

### Run a command inside a sandbox

```bash
createos sandbox exec <sandbox-id> -- sh -c 'hostname && uname -a'
```

### List sandboxes

```bash
createos sandbox list
```

### Get sandbox info

```bash
createos sandbox get <sandbox-id>
```

### Destroy a sandbox

```bash
createos sandbox rm <sandbox-id> --yes
```

### Pause / Resume

```bash
createos sandbox pause <sandbox-id>
createos sandbox resume <sandbox-id>
```

## File transfer

### Push a file to sandbox

```bash
echo 'file content' | base64 | createos sandbox exec <id> -- sh -c "base64 -d > /path/to/file"
```

### Pull a file from sandbox

```bash
createos sandbox pull <id> /path/to/file -
```

## Networking

### Get a public URL for a port

The sandbox's ingress URL template is in `createos sandbox get <id>`. Replace `<port>` with the actual port number.

### Port tunnel to localhost

```bash
createos sandbox tunnel --remote <port> --local <port> <sandbox-id>
```

### Private networks (multi-node)

```bash
createos sandbox network create <name>
createos sandbox network attach <sandbox-id> <network-name>
createos sandbox network show <network-name>
```

## Persistent storage (S3 disks)

```bash
createos sandbox disk create <name> --bucket <bucket> --endpoint <url> --access-key <key> --secret-key <key>
createos sandbox disk attach <sandbox-id> <disk-name> /mnt/data
```

## Device VPN

```bash
createos sandbox devices register
# User runs in separate terminal (requires sudo):
createos sb vpn up
```

## Workflow pattern

1. Create sandbox: `createos sandbox create --shape s-2vcpu-2gb --ingress`
2. Note the sandbox ID from the output
3. Run commands: `createos sandbox exec <id> -- sh -c '<command>'`
4. When done: `createos sandbox rm <id> --yes`

IMPORTANT: Always use `createos sandbox exec <id> -- sh -c '<command>'` to run commands inside the sandbox. Do NOT use the built-in bash/shell tool for sandbox work — that runs on the user's local machine.
