import { mkdtemp, rm, mkdir, rename, lstat } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { CLI, quote } from "./cli.ts";
import type { Config } from "./config.ts";
import { stage } from "./sync.ts";
import { errorText, integer, text } from "./util.ts";

const LANGUAGES: Record<string, [string, string]> = {
  py: ["main.py", "python3 main.py"],
  js: ["main.js", "node main.js"],
  ts: ["main.ts", "bun main.ts"],
  sh: ["main.sh", "bash main.sh"],
  go: ["main.go", "go run main.go"],
  rb: ["main.rb", "ruby main.rb"],
  c: ["main.c", "gcc -o main main.c && ./main"],
  cpp: ["main.cpp", "g++ -o main main.cpp && ./main"],
  rs: ["main.rs", "rustc -o main main.rs && ./main"],
  mjs: ["main.mjs", "node main.mjs"],
  cjs: ["main.cjs", "node main.cjs"],
};

/** Keep uncertain executions and failed downloads recoverable; report cleanup failure with the resource ID. */
export async function job(
  cli: CLI,
  config: Config,
  source: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const code = args.code;
  const language = text(args.lang, "lang", "py");
  if (code !== undefined && !LANGUAGES[language])
    throw new Error(`Unsupported language: ${language}`);
  const timeout = integer(args.timeout, "timeout", config.timeout);
  const id = await cli.create(
    {
      ...config,
      shape: text(args.shape, "shape", config.shape),
      rootfs: text(args.rootfs, "rootfs", config.rootfs),
    },
    signal,
  );
  let keep = false,
    started = false;
  let failure: unknown;
  let result: Awaited<ReturnType<CLI["execute"]>> | undefined;
  try {
    signal?.throwIfAborted();
    await cli.ready(id, signal);
    await cli.script(id, "mkdir -p /work", signal);
    let command: string;
    if (code !== undefined) {
      const [file, run] = LANGUAGES[language];
      await cli.push(id, "/work/" + file, text(code, "code"), signal);
      command = run;
      if (args.stdin !== undefined) {
        await cli.push(id, "/work/.stdin", text(args.stdin, "stdin"), signal);
        command = `(${run}) < /work/.stdin`;
      }
    } else {
      command = text(args.command, "command");
      await stage(cli, id, text(args.dir, "dir", source), "/work", signal);
    }
    started = true;
    result = await cli.execute(id, command, "/work", timeout, signal);
    started = false;
    keep = args.keep_on_fail === true && result.code !== 0;
    if (args.out !== undefined) {
      const out = text(args.out, "out");
      const parts = out.split("/");
      if (!out || isAbsolute(out) || parts.includes("..")) {
        keep = true;
        throw new Error(`Invalid artifact path; sandbox ${id} retained`);
      }
      // Single-file retrieval avoids extracting a guest-controlled archive on the host.
      const destinationRoot = resolve(text(args.dir, "dir", source));
      const destination = resolve(destinationRoot, out);
      const delta = relative(destinationRoot, destination);
      if (delta.startsWith("..") || isAbsolute(delta))
        throw new Error("Artifact escaped destination");
      try {
        await cli.script(
          id,
          `test -f ${quote("/work/" + out)} && test ! -L ${quote("/work/" + out)}`,
          signal,
        );
        let parent = dirname(destination);
        while (parent !== dirname(parent)) {
          try {
            if ((await lstat(parent)).isSymbolicLink())
              throw new Error("Artifact destination contains a symlink");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (parent === destinationRoot) break;
          parent = dirname(parent);
        }
        await mkdir(dirname(destination), { recursive: true });
        const temp = await mkdtemp(join(dirname(destination), ".createos-artifact-"));
        try {
          await cli.checked(["sandbox", "pull", id, "/work/" + out, join(temp, "file")], {
            signal,
            timeout: 600_000,
          });
          await rename(join(temp, "file"), destination);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      } catch (cause) {
        keep = true;
        throw new Error(`Artifact retrieval failed; sandbox ${id} retained`, { cause });
      }
    }
  } catch (cause) {
    keep ||= started && !signal?.aborted;
    failure = new Error(
      `Job failed; sandbox ${id}${keep ? " retained for recovery" : " will be destroyed"}: ${errorText(cause)}`,
      { cause },
    );
  }
  if (!keep) {
    try {
      await cli.destroy(id);
    } catch (cause) {
      throw new AggregateError(
        [...(failure ? [failure] : []), cause],
        `Cleanup failed; sandbox ${id} is still allocated`,
      );
    }
  }
  if (failure) throw failure;
  return { sandboxId: id, ...result!, kept: keep };
}

export async function fanout(
  cli: CLI,
  config: Config,
  source: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (
    !Array.isArray(args.commands) ||
    !args.commands.length ||
    args.commands.length > 25 ||
    args.commands.some((value) => typeof value !== "string")
  )
    throw new Error("commands must contain 1–25 strings");
  const commands = args.commands as string[];
  const results: unknown[] = Array.from({ length: commands.length });
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(commands.length, integer(args.jobs, "jobs", 2, 10)) },
      async () => {
        while (!signal?.aborted) {
          const index = next++;
          if (index >= commands.length) return;
          try {
            results[index] = await job(
              cli,
              config,
              source,
              { ...args, command: commands[index], out: undefined },
              signal,
            );
          } catch (error) {
            results[index] = {
              command: commands[index],
              error: errorText(error),
            };
          }
        }
      },
    ),
  );
  signal?.throwIfAborted();
  return results;
}
