import { describe, expect, test } from "claude-code/testing";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const BOXES = [
  {
    id: "sb-1",
    name: "cos-proj-shop", // made by this plugin
    status: "running",
    ip: "10.0.0.2",
    vcpu: 2,
    mem_mib: 4096,
    shape: "s-2vcpu-4gb",
    rootfs: "devbox:1",
    region: "eu",
    created_at: ago(12 * 60_000),
    ingress_enabled: true,
    ingress_url_template: "https://1-<port>.app.sb.createos.sh",
  },
  {
    id: "sb-2",
    name: "golden", // made by something else
    status: "paused",
    ip: "",
    vcpu: 1,
    mem_mib: 2048,
    shape: "s-1vcpu-2gb",
    rootfs: "devbox:1",
    region: "eu",
    created_at: ago(3 * 3_600_000),
    ingress_enabled: false,
  },
];

const PANE = {
  title: "CreateOS Sandboxes",
  isFocused: true,
  bodyColumns: 120,
  placement: "dock",
} as any;
const result = (exitCode: number, stdout: string, stderr = "") => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
});

// Actions run unawaited from the ui.message hook; let them finish.
const settle = () => new Promise((r) => setTimeout(r, 20));

async function boot(
  $: any,
  on: any,
  surface: "terminal" | "desktop",
  answer: (argv: string[]) => ReturnType<typeof result>,
) {
  const calls: string[][] = [];
  const envs: unknown[] = [];
  on("process.run", (_$: unknown, e: any) => {
    calls.push([...e.argv]);
    envs.push(e.init?.env);
    return answer([...e.argv]);
  });
  on("session.start", ($: unknown, e: any) => ({ cwd: e.cwd }) as any);
  on("ui.open", () => ({ value: { isPlaced: true } }) as any);
  on("command.register", () => ({ value: undefined }) as any);
  on("clock.every", () => ({ value: {} }) as any);
  on("ui.toast", () => ({ value: undefined }) as any);
  on("ui.panes", () => ({ value: [] }) as any);
  await $.session.start({ surface, isInteractive: true, cwd: "/work" } as any);
  const ui = await $.ui.mount({
    plugin: "createos-sandbox",
    surface,
    component: "Pane",
    requestId: "createos-sandboxes",
    props: PANE,
    viewport: { columns: 160, rows: 40 },
  });
  await ui.resize({ columns: 120, rows: 32 });
  const has = async (text: RegExp) => (await ui.find({ text, in: "tui" })) !== undefined;
  return { ui, calls, envs, has };
}

const listed = (argv: string[]) =>
  result(0, argv.join(" ") === "createos -o json sandbox ls" ? JSON.stringify(BOXES) : "done");

describe("createos sandbox TUI", () => {
  for (const surface of ["terminal", "desktop"] as const) {
    test(`keys drive selection, filter, palette and actions (${surface})`, async ($, on) => {
      const { ui, calls, has } = await boot($, on, surface, listed);
      const key = (k: string, ctrl?: true) => ui.key({ key: k, ctrl, in: "tui" });

      expect(await has(/Sandboxes 2\/2/)).toBe(true);
      expect(await has(/^ Filter {2}$/)).toBe(true); // the footer's key hints

      // The project box is selected on open; p pauses it.
      await key("p");
      expect(calls).toContainEqual(["createos", "sandbox", "pause", "sb-1"]);

      // j moves to golden (paused, not ours): pause is refused, Details and Down warn.
      await key("j");
      await key("p");
      expect(await has(/Pause: not available/)).toBe(true);
      expect(await has(/another tool/)).toBe(true);
      await key("d");
      expect(await has(/NOT made by this plugin/)).toBe(true);
      await key("n");
      await key("s");
      expect(calls).toContainEqual(["createos", "sandbox", "resume", "sb-2"]);

      // Filter narrows; backspace erases, then closes the empty field.
      await key("/");
      for (const k of "gold") await key(k);
      expect(await has(/Sandboxes 1\/2/)).toBe(true);
      for (let i = 0; i < 5; i++) await key("backspace");
      expect(await has(/Sandboxes 2\/2/)).toBe(true);
      expect(await has(/^ Filter {2}$/)).toBe(true);

      // Down asks first; only y destroys — a double-tapped d does not.
      await key("k");
      await key("d");
      expect(await has(/Destroy cos-proj-shop\?/)).toBe(true);
      await key("d");
      expect(calls.some((c) => c.includes("rm"))).toBe(false);
      await key("d");
      await key("y");
      expect(calls).toContainEqual(["createos", "sandbox", "rm", "-y", "sb-1"]);

      // Exec sends argv, not a shell string, to the selected box.
      await key("x");
      for (const k of "ls") await key(k);
      await key("return");
      expect(calls).toContainEqual([
        "createos",
        "sandbox",
        "exec",
        "sb-1",
        "--",
        "bash",
        "-lc",
        "ls",
      ]);

      // No ctrl chord does anything: they belong to Claude Code, Ghostty and tmux.
      for (const k of ["g", "]", "p", "n", "h", "s"]) await key(k, true);
      expect(await has(/Actions · cos-proj-shop/)).toBe(false);

      // ":" opens the palette; backspace on an empty query closes it; search + enter runs.
      await key(":");
      expect(await has(/Actions · cos-proj-shop/)).toBe(true);
      await key("backspace");
      expect(await has(/Actions · cos-proj-shop/)).toBe(false);
      await key(":");
      for (const k of "unexp") await key(k);
      await key("return");
      expect(calls).toContainEqual(["createos", "sandbox", "edit", "sb-1", "--ingress", "off"]);

      // A click on a table row selects that box (row 0 of the data sits at y = 1 + 3 + 2).
      await ui.pointer({ type: "down", x: 4, y: 7, button: "left", in: "tui" } as any);
      expect(await has(/▌ golden/)).toBe(true);
      await settle();
      await key("s");
      await settle();
      expect(calls.filter((c) => c.join(" ") === "createos sandbox resume sb-2")).toHaveLength(2);
      await ui.unmount();
    });

    test(`untrusted posts are refused (${surface})`, async ($, on) => {
      const { ui, calls } = await boot($, on, surface, listed);
      const before = calls.length;
      await ui.post({ act: "down", id: "sb-not-mine" }, { in: "tui" });
      await ui.post({ act: "rm -rf", id: "sb-1" }, { in: "tui" });
      await ui.post({ act: "exec", id: "sb-1", cmd: "" }, { in: "tui" });
      await ui.post("garbage", { in: "tui" });
      // Only list refreshes may follow; no action ran.
      expect(calls.slice(before).filter((c) => c[1] !== "-o")).toEqual([]);
      await ui.unmount();
    });

    // Found live: a control character anywhere in a drawn Text blanks the whole
    // pane. These are the CLI's real signed-out outputs, coloured and plain.
    for (const [kind, stdout] of [
      ["coloured", "\x1b[41m ERROR \x1b[0m failed to verify token\r\n\x1b]0;title\x07"],
      [
        "expired session",
        "  ERROR   your session has expired and could not be renewed — run 'createos login' to sign in again\n",
      ],
    ] as const) {
      test(`a ${kind} CLI error reads as a sign-in hint (${surface})`, async ($, on) => {
        const { ui, envs, has } = await boot($, on, surface, () => result(1, stdout));
        expect(await has(/Not signed in to CreateOS/)).toBe(true);
        expect(envs[0]).toMatchObject({ NO_COLOR: "1" });
        await ui.unmount();
      });
    }

    test(`a spinner in CLI output shows only its last frame (${surface})`, async ($, on) => {
      const { ui, has } = await boot($, on, surface, (argv) =>
        argv[2] === "pause"
          ? result(0, "▄ Pausing sb-1 (1s)\r▀ Pausing sb-1 (2s)\r SUCCESS  Paused sb-1\n")
          : listed(argv),
      );
      await ui.key({ key: "p", in: "tui" });
      await settle();
      expect(await has(/SUCCESS {2}Paused sb-1/)).toBe(true);
      expect(await has(/Pausing sb-1/)).toBe(false);
      await ui.unmount();
    });

    test(`a paste with tabs and newlines does not blank the pane (${surface})`, async ($, on) => {
      const { ui, calls, has } = await boot($, on, surface, listed);
      await ui.key({ key: "/", in: "tui" });
      await ui.key({ key: "pro\tj\r\n", in: "tui" });
      expect(await has(/⌕ pro j/)).toBe(true);
      for (let i = 0; i < 7; i++) await ui.key({ key: "backspace", in: "tui" }); // clear + close
      await ui.key({ key: "x", in: "tui" });
      await ui.key({ key: "echo a\necho b", in: "tui" });
      await ui.key({ key: "return", in: "tui" });
      await settle();
      expect(calls).toContainEqual([
        "createos",
        "sandbox",
        "exec",
        "sb-1",
        "--",
        "bash",
        "-lc",
        "echo a echo b",
      ]);
      expect(await has(/Sandboxes/)).toBe(true); // still drawing
      await ui.unmount();
    });
  }
});
