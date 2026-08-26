# CreateOS Sandbox for Orca — moved

This plugin now lives in its own repository:

**https://github.com/NodeOps-app/createos-orca-plugin**

## Why it moved

Orca installs a plugin by cloning a whole repository and reading
`orca-plugin.json` from its root. A subdirectory of this monorepo cannot be
installed that way, so the plugin could not be distributed from here.

Two workarounds were ruled out by testing against Orca's installer:

- A symlink to the manifest at this repository's root is rejected —
  Orca refuses symlinks anywhere in plugin content.
- Putting the manifest at this repository's root fails for the same reason,
  because the root already carries symlinks for the Pi extension. It would
  also make the whole monorepo the plugin's content.

## Install

```
https://github.com/NodeOps-app/createos-orca-plugin.git#v0.1.0
```

Paste that into Orca: Settings > Plugins > Install from git URL.

The `createos sandbox setup orca` command it drives still lives in
[createos-cli](https://github.com/NodeOps-app/createos-cli).
