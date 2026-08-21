import { Buffer } from "node:buffer";
import { Context, Service } from "@deepseek-ai/cordis";
import type { CreateOSSandbox } from "@nodeops-createos/dsh-createos/createos";
import CreateOSFileSystem from "@nodeops-createos/dsh-createos/fs";
import { describe, expect, it } from "vitest";

function encodedNul(...fields: string[]): string {
  return Buffer.from(`${fields.join("\0")}\0`).toString("base64");
}

class FakeCreateOS extends Service {
  readonly cwd = "/root/workspace";
  readonly files = new Map<string, Uint8Array>([
    ["/root/workspace/file.txt", new TextEncoder().encode("hello\n")],
  ]);
  readonly sandbox = {
    id: "sb_test",
    files: {
      download: async (path: string) => (this.files.get(path) as Uint8Array).slice().buffer,
      upload: async (path: string, body: BodyInit) => {
        if (typeof body !== "string") throw new Error("test client expects string uploads");
        this.files.set(path, new TextEncoder().encode(body));
      },
    },
    runCommand: async (command: string, args: string[]) => {
      if (command === "/bin/sh" && args[1]?.includes("realpath")) {
        return result(Buffer.from(`${args[3]}\0`).toString("base64"));
      }
      if (command === "/bin/sh" && args[1]?.includes("stat")) {
        const path = args[3] as string;
        const data = this.files.get(path);
        return data === undefined
          ? result("", "stat: No such file", 1)
          : result(
              encodedNul(
                "regular file",
                String(data.byteLength),
                "600",
                "2026-08-19 00:00:00.000000000 +0000",
              ),
            );
      }
      return result("");
    },
  } as unknown as CreateOSSandbox;

  constructor(ctx: Context) {
    super(ctx, "createos");
  }
  getSandbox(): Promise<CreateOSSandbox> {
    return Promise.resolve(this.sandbox);
  }
  getClient() {
    return {
      http: {
        requestRaw: async (_method: string, _path: string, options: { query: { path: string } }) =>
          new Response((this.files.get(options.query.path) ?? new Uint8Array()).slice().buffer),
        throwForResponse: async () => {
          throw new Error("request failed");
        },
      },
    };
  }
}

function result(stdout: string, stderr = "", exitCode = 0) {
  return { result: { stdout, stderr, exit_code: exitCode } };
}

describe("CreateOSFileSystem", () => {
  it("resolves canonical remote identity and reads bounded text and bytes", async () => {
    const ctx = new Context();
    const owner = await ctx.plugin(FakeCreateOS);
    const fsFiber = await ctx.plugin(CreateOSFileSystem);
    const fs = ctx.fs;

    const target = await fs.resolve("file.txt");
    expect(String(target.targetKey)).toBe("/root/workspace/file.txt");
    await expect(fs.stat(target)).resolves.toMatchObject({ type: "file", size: 6 });
    await expect(fs.readText(target)).resolves.toBe("hello\n");
    await expect(fs.readBytes(target, undefined, 5)).rejects.toMatchObject({
      code: "FS_TOO_LARGE",
    });
    await expect(fs.readBytes(target, undefined, 6)).resolves.toEqual(
      new TextEncoder().encode("hello\n"),
    );

    await fsFiber.dispose();
    await owner.dispose();
  });
});
