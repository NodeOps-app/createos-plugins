import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}mcp`, { recursive: true });
for (const [entry, output] of [["src/server-entry.ts", "server"], ["src/worker-entry.ts", "worker"]]) {
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: `mcp/${output}.mjs`, bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
}
const panel = await build({ absWorkingDir: root, entryPoints: ["src/panel.ts"], bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, write: false });
const html = await readFile(`${root}src/panel.html`, "utf8");
await writeFile(`${root}mcp/job-panel.html`, html.replace("/* PANEL_SCRIPT */", panel.outputFiles[0].text.replaceAll("</script", "<\\/script")));
