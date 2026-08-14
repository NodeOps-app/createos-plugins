#!/usr/bin/env bun
/**
 * End-to-end smoke test against a real CreateOS Sandbox.
 *
 * Drives the three providers through a bare Cordis context — no harness, no
 * LLM, no API key for DeepSeek — so it exercises exactly the seam contracts
 * that `dsh` would exercise, and nothing else.
 *
 * Creates one sandbox, runs the checks, and destroys it on the way out.
 *
 *   CREATEOS_SANDBOX_API_KEY=... bun scripts/smoke.ts
 *
 * The key falls back to `~/.createos/config.json`, which the createos CLI
 * writes on login.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import CreateosRuntime from "../src/index.ts";
import CreateosFileSystem from "../src/fs.ts";
import CreateosSubprocess from "../src/subprocess.ts";
import type { SubprocessCollect } from "@deepseek-ai/dsh-subprocess";

const SHAPE = process.env.CREATEOS_SHAPE ?? "s-0.5vcpu-1gb";
const COLLECT: SubprocessCollect = { maxBytes: 65_536, spill: { maxBytes: 1_048_576 } };

function resolveApiKey(): string {
  const fromEnv = process.env.CREATEOS_SANDBOX_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    const config = JSON.parse(
      readFileSync(join(homedir(), ".createos", "config.json"), "utf8"),
    ) as {
      apiKey?: string;
    };
    if (config.apiKey !== undefined && config.apiKey.length > 0) return config.apiKey;
  } catch {
    // Fall through to the explicit failure below.
  }
  throw new Error("set CREATEOS_SANDBOX_API_KEY, or run `createos login` first");
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

async function collectRun(
  subprocess: CreateosSubprocess,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; exitCode: number | null }> {
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: "ignore", stdout: COLLECT, stderr: COLLECT },
    graceMs: 5_000,
    env,
  });
  const outcome = await handle.done;
  return {
    stdout: handle.collected.stdout?.readFrom(0).text ?? "",
    exitCode: outcome.exitCode,
  };
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey();
  const ctx = new Context();

  console.log(`\ncreating sandbox (${SHAPE})…`);
  const started = Date.now();
  const runtime = ctx.plugin(CreateosRuntime, { apiKey, shape: SHAPE, disposeAction: "destroy" });
  ctx.plugin(CreateosFileSystem);
  ctx.plugin(CreateosSubprocess);

  const finished = new Promise<void>((resolve, reject) => {
    ctx.inject(["createos", "fs", "subprocess"], async (scoped) => {
      try {
        const { fs, subprocess, createos } = scoped;
        // The service registers before its sandbox exists (creation is eager but
        // async), so readiness is the first getSandbox(), not the inject callback.
        const box = await createos.getSandbox();
        console.log(`sandbox ${box.id} ready in ${Date.now() - started}ms\n`);

        console.log("subprocess:");
        const echo = await subprocess.resolveExecutable("echo");
        check("resolveExecutable('echo') returns an absolute path", echo.startsWith("/"), echo);

        const hello = await collectRun(
          subprocess as CreateosSubprocess,
          [echo, "hello", "world"],
          createos.cwd,
        );
        check("collected stdout", hello.stdout === "hello world\n", hello.stdout);
        check("exit code 0", hello.exitCode === 0, hello.exitCode);

        const pwd = await subprocess.resolveExecutable("pwd");
        const inTmp = await collectRun(subprocess as CreateosSubprocess, [pwd], "/tmp");
        check("cwd is honoured (env -C)", inTmp.stdout.trim() === "/tmp", inTmp.stdout);

        const printenv = await subprocess.resolveExecutable("printenv");
        const withEnv = await collectRun(
          subprocess as CreateosSubprocess,
          [printenv, "SMOKE_VAR"],
          createos.cwd,
          { SMOKE_VAR: "smoke-value" },
        );
        check("per-spawn env is honoured", withEnv.stdout.trim() === "smoke-value", withEnv.stdout);

        const failing = await subprocess.resolveExecutable("false");
        const nonZero = await collectRun(subprocess as CreateosSubprocess, [failing], createos.cwd);
        check("non-zero exit is reported", nonZero.exitCode === 1, nonZero.exitCode);

        console.log("\nsubprocess termination:");
        const sleep = await subprocess.resolveExecutable("sleep");
        const longRunning = subprocess.spawn({
          argv: [sleep, "120"],
          cwd: createos.cwd,
          stdio: { stdin: "ignore", stdout: COLLECT, stderr: COLLECT },
          graceMs: 3_000,
        });
        await new Promise((r) => setTimeout(r, 1_500));
        const killedAt = Date.now();
        longRunning.terminate();
        const killedOutcome = await longRunning.done;
        const elapsed = Date.now() - killedAt;
        check("terminate() settles the process", elapsed < 30_000, `${elapsed}ms`);
        check("terminate() reports a signal", killedOutcome.signal !== null, killedOutcome);
        check("the tree is actually gone", await longRunning.waitForExit());

        console.log("\nfilesystem:");
        const target = await fs.resolve("smoke.txt", { cwd: createos.cwd });
        check(
          "resolve() yields an absolute display path",
          target.displayPath.startsWith("/"),
          target.displayPath,
        );

        const write = await fs.writeText(target, "alpha\nbeta\n");
        check("writeText() creates", write.operation === "create", write.operation);

        const info = await fs.stat(target);
        check("stat() reports a regular file", info?.type === "file", info);
        check("stat() reports the size", info?.size === 11, info?.size);

        const readBack = await fs.readText(target);
        check("readText() round-trips", readBack === "alpha\nbeta\n", readBack);

        const edited = await fs.editText(target, {
          oldString: "beta",
          newString: "gamma",
          replaceAll: false,
        });
        check("editText() applies the edit", edited.after === "alpha\ngamma\n", edited.after);
        check("editText() changes the version", edited.version !== info?.version);

        const afterEdit = await fs.readText(target);
        check("the edit is durable", afterEdit === "alpha\ngamma\n", afterEdit);

        const stale = await fs
          .writeText(target, "nope", { kind: "replaceIfVersion", version: info!.version })
          .then(() => "no-error")
          .catch((error: unknown) => (error as { code?: string }).code);
        check("a stale version guard is rejected", stale === "FS_STALE_VERSION", stale);

        const dir = await fs.resolve(createos.cwd);
        const listed = await fs.listDir(dir);
        check(
          "listDir() finds the file",
          listed.some((e) => e.name === "smoke.txt"),
          listed.map((e) => e.name),
        );

        const missing = await fs.stat(await fs.resolve("does-not-exist", { cwd: createos.cwd }));
        check("stat() of an absent path is undefined", missing === undefined, missing);

        // Cross-provider: the file the fs provider wrote is visible to a process.
        const cat = await subprocess.resolveExecutable("cat");
        const seen = await collectRun(
          subprocess as CreateosSubprocess,
          [cat, fs.processPath(target)],
          createos.cwd,
        );
        check(
          "fs and subprocess share one execution world",
          seen.stdout === "alpha\ngamma\n",
          seen.stdout,
        );

        resolve();
      } catch (error: unknown) {
        reject(error);
      }
    });
  });

  try {
    await finished;
  } finally {
    console.log("\ndestroying sandbox…");
    await runtime.dispose();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
