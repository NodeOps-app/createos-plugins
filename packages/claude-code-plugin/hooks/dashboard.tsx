// CreateOS Sandbox dashboard: a live pane listing the account's sandboxes.
// The skill and the `cos` driver stay the model's path; this pane is the
// person's view of the same boxes.
//
// Design: this hooks module owns the data and every side effect; the TUI
// itself is a Client surface module (tui.tsx) that only draws and posts
// intents. Every action shells out to the authed `createos` CLI by argv (never
// a shell string), except "Up", which goes through `cos up` so the project-box
// conventions (state file, naming, keepalive) stay in one place.
import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { DashboardView, Sandbox, TuiProps } from "../types";

const PANE = "createos-sandboxes";
const TITLE = "CreateOS Sandboxes";
const POLL_MS = 15_000;
const LOG_LINES = 12;
const MAX_CMD = 2_000;

const view = atom(
  { plugin: "createos-sandbox", key: "view" } as const,
  {
    boxes: [],
    error: "",
    refreshedAt: "",
  } as DashboardView,
);
const busy = atom({ plugin: "createos-sandbox", key: "busy" } as const, "");
const log = atom({ plugin: "createos-sandbox", key: "log" } as const, "");

type $ = EngineInterface;

// Every CLI call goes through here. A drawn Text refuses control characters,
// so colour codes or a `\r` progress bar in any output would blank the pane.
async function run($: $, argv: string[], timeoutMs?: number) {
  const r = await $.process
    .run(argv, { timeoutMs, env: { NO_COLOR: "1", TERM: "dumb" } })
    .catch((err: unknown) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  return { exitCode: r.exitCode, stdout: clean(r.stdout), stderr: clean(r.stderr) };
}

/* oxlint-disable no-control-regex -- stripping control characters is the point */
const clean = (s: string) =>
  s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI (colours, cursor moves)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC (titles, links)
    // A bare \r redraws the line in a terminal (spinners, progress): keep only
    // the last frame of each line, as the person would have seen it.
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
/* oxlint-enable no-control-regex */

// One line, nothing a Text refuses: for labels built from user input.
const oneLine = (s: string) => clean(s).replace(/\s*\n\s*/g, " ");

const AUTH_ERROR =
  /verify token|invalid api key|unauthori[sz]ed|not (signed|logged) in|session has expired|(sign|log) ?in again/i;

async function refresh($: $) {
  const r = await run($, ["createos", "-o", "json", "sandbox", "ls"]);
  const refreshedAt = new Date().toTimeString().slice(0, 8);
  if (r.exitCode !== 0) {
    const all = r.stderr + r.stdout;
    const error = /ENOENT|not found in \$PATH/i.test(all)
      ? "The createos CLI is not installed. Restart Claude Code (the plugin installs it at session start)."
      : AUTH_ERROR.test(all)
        ? "Not signed in to CreateOS. Run `createos login` in a terminal, or export CREATEOS_API_KEY and restart Claude Code."
        : firstLine(all) || "createos sandbox ls failed";
    // Drop the old list: acting on a stale row would hit a box that may be gone.
    await update($, view, () => ({ boxes: [], error, refreshedAt }));
    return;
  }
  let boxes: Sandbox[] = [];
  try {
    boxes = JSON.parse(r.stdout || "[]") ?? [];
  } catch {
    await update($, view, (v) => ({ ...v, error: "unreadable JSON from createos", refreshedAt }));
    return;
  }
  await update($, view, () => ({ boxes, error: "", refreshedAt }));
}

// Runs one action, shows its tail in the pane, then re-reads the list.
async function act($: $, rawLabel: string, argv: string[], timeoutMs = 120_000) {
  const label = oneLine(rawLabel);
  // ponytail: one action at a time; a queue if people stack actions often.
  const running = await read($, busy);
  if (running) return void $.ui.toast(`Busy with "${running}" — try again when it ends`);
  await update($, busy, () => label);
  try {
    const r = await run($, argv, timeoutMs);
    const out = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-LOG_LINES).join("\n");
    // Words, not ✓/✗: some terminals draw those two cells wide and break the frame.
    await update(
      $,
      log,
      () => `${r.exitCode === 0 ? "ok" : `fail ${r.exitCode}`} ${label}\n${out}`,
    );
  } catch (err) {
    await update($, log, () => `fail ${label}\n${oneLine(String(err))}`);
  } finally {
    await update($, busy, () => "");
  }
  await refresh($);
}

// The TUI's posts are untrusted input: only known verbs, only boxes in the list.
async function handle($: $, data: unknown, surface: string) {
  if (typeof data !== "object" || data === null) return;
  const { act: verb, id, cmd } = data as Record<string, unknown>;
  if (verb === "refresh") return refresh($);
  // By absolute path: `cos` is on PATH only after `cos install`.
  if (verb === "up") return act($, "cos up", [`${$.plugin.root}/scripts/cos`, "up"], 300_000);
  const box = (await read($, view)).boxes.find((b) => b.id === id);
  if (!box) return;
  const sb = (...rest: string[]) => ["createos", "sandbox", ...rest];
  switch (verb) {
    case "pause":
    case "resume":
    case "fork":
      return act($, `${verb} ${box.name}`, sb(verb, box.id));
    case "expose":
    case "unexpose":
      return act(
        $,
        `${verb} ${box.name}`,
        sb("edit", box.id, "--ingress", verb === "expose" ? "on" : "off"),
      );
    case "down":
      return act($, `down ${box.name}`, sb("rm", "-y", box.id));
    case "exec":
      if (typeof cmd !== "string" || !cmd.trim() || cmd.length > MAX_CMD) return;
      return act($, `$ ${cmd}`, sb("exec", box.id, "--", "bash", "-lc", cmd));
    case "copy":
      if (!box.ingress_url_template) return;
      await $.ui.copy({ text: box.ingress_url_template, surface: surface as never });
      return $.ui.toast("Sandbox URL copied");
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await $.command.register({
      name: "sandboxes",
      description: "Open the live CreateOS Sandbox dashboard pane",
    });
    await refresh($);
    // Poll only while the pane is open: a closed pane needs no CLI traffic.
    $.clock.every(POLL_MS, async () => {
      if ((await $.ui.panes()).some((p) => p.id === PANE)) await refresh($);
    });
    if ((await read($, view)).boxes.length > 0)
      void $.ui.open({ id: PANE, title: TITLE, columns: 120 });
    return result;
  });

  on("command.run", { command: "sandboxes" }, async ($, e) => {
    await refresh($);
    // About half the terminal, so the chat beside it stays readable at 140
    // columns and the TUI uses the room on a wide screen.
    const columns = Math.max(80, Math.min(140, Math.round(e.presentation.columns * 0.55)));
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, columns, rows: 30 });
    return {
      text: opened.isPlaced
        ? "Sandbox dashboard opened. Click it to type; Esc returns to the prompt."
        : `Dashboard waits: ${opened.reason}`,
    };
  });

  // Claude's own `cos …` / `createos …` calls change the list: re-read after them.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const result = await next(e);
    if (/\b(cos|createos)\b/.test(String(e.command ?? ""))) void refresh($);
    return result;
  });

  on("ui.message", { component: "Pane", requestId: PANE }, async ($, e) => {
    void handle($, e.data, e.surface);
    return {};
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const props: TuiProps = {
      ...(await read($, view)),
      busy: await read($, busy),
      log: await read($, log),
    };
    if ("Client" in elements) {
      const { Client } = elements;
      // The rows the pane gives its body, so the TUI never scrolls. Measured
      // live on 2.1.287: a docked pane shows bodyRows - 1 (its last row is chrome).
      const rows = Math.max(16, (e.props.scroll?.bodyRows ?? 31) - 1);
      return (
        <Client
          key="tui"
          module="./tui.tsx"
          props={props}
          width={e.props.bodyColumns}
          height={rows}
        />
      );
    }
    // vscode and mobile draw no Client: a plain read-only list.
    const { Box, Text } = elements;
    return (
      <Box flexDirection="column">
        {props.error !== "" && <Text color="red">{props.error}</Text>}
        {props.boxes.map((b) => (
          <Text key={b.id}>
            {b.status === "running" ? "●" : "◌"} {b.name} {b.status}
          </Text>
        ))}
      </Box>
    );
  });
};

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
