# AGENTS.md

This repository provides one independently installable DeepSeek Harness execution-world bundle for CreateOS.

- Keep `ctx.fs` and `ctx.subprocess` backed by the same `ctx.createos` sandbox owner.
- Treat managed-process ids as opaque branded values and validate wire responses.
- Disable retries for allocation, input, resize, signal, stdin-close, and other ambiguous writes.
- Preserve bounded reads, atomic sibling-file writes, complete process-tree termination, and teardown ownership.
- Update `README.md` and `cordis.patch.yml` when configuration or runtime requirements change.
- Run `DSH_REPO=/path/to/deepseek-harness npm run check` before committing.
