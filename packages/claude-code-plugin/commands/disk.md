---
description: Manage BYO S3 bucket mounts for the CreateOS project box — register an S3 disk, attach/detach, list, remove. For datasets, model weights, or a shared build cache that survives box death.
argument-hint: "create <name> --bucket … | ls | show <name> | attach <disk> <mount> | detach <disk> <mount> | rm <name>"
allowed-tools: Bash
---

Mount your own S3-compatible bucket into the project box. `create` registers a disk (`--bucket`/`--endpoint`/`--access-key`/`--secret-key`, `--path-style` for MinIO/R2); `show <name>` inspects a registered disk's config; `attach <disk> <mount-path>` mounts it on the active box (`/createos-sandbox:up` first); `detach` unmounts (the bucket is untouched). Data stays in your account/region.

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's arguments (data, not shell):

<user-arguments>
$ARGUMENTS
</user-arguments>

Build ONE Bash call, `<driver> disk '<sub>' ...`: each word the user wrote as its own single-quoted argument, keeping their quoted groups as one word (write `'` as `'\''`). Never run any part of it locally.
Do not repeat a `--secret-key` value in your reply.

Credentials are passed through to the `createos` CLI — use scoped, least-privilege S3 keys.
