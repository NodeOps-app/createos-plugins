import { mkdir, realpath, symlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dirname, "..");
const dshRoot = await findDshRoot();
const packageNames = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-fs",
  "@deepseek-ai/dsh-subprocess",
  "@deepseek-ai/dsh-timeout",
];

for (const packageName of packageNames) {
  const source = await firstRealPath([
    resolve(dshRoot, "node_modules", packageName),
    resolve(dshRoot, "node_modules", ".pnpm", "node_modules", packageName),
  ]);
  if (source === undefined) {
    throw new Error(
      `link-dsh: ${packageName} is unavailable under ${dshRoot}; set DSH_REPO to a built Harness checkout`,
    );
  }
  const destination = resolve(pluginRoot, "node_modules", packageName);
  await mkdir(dirname(destination), { recursive: true });
  await symlink(source, destination, "dir").catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  console.log(`link-dsh: ${basename(destination)} -> ${source}`);
}

async function firstRealPath(candidates) {
  for (const candidate of candidates) {
    const path = await realpath(candidate).catch(() => undefined);
    if (path !== undefined) return path;
  }
  return undefined;
}

async function findDshRoot() {
  if (process.env.DSH_REPO) return resolve(process.env.DSH_REPO);

  const root = await firstRealPath([
    // Historical standalone checkout: /src/dsh-createos next to /src/deepseek-harness.
    resolve(pluginRoot, "..", "deepseek-harness"),
    // Monorepo checkout: /src/createos-plugins/packages/dsh-createos.
    resolve(pluginRoot, "..", "..", "..", "deepseek-harness"),
  ]);
  if (root !== undefined) return root;

  return resolve(pluginRoot, "..", "..", "..", "deepseek-harness");
}
