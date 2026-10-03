// The sandbox TUI: a Client surface module drawn inside the dashboard pane.
// It owns only view state (cursor, filter, mode, palette); every action is
// posted to the hooks module (dashboard.tsx), which validates it and runs the
// CLI. Layout is computed in cells by `layout()` so the pointer handler can
// hit-test the same rectangles the tree draws.
import type {
  ClientKeyEvent,
  ClientPointerEvent,
  ClientSurface,
  JsonValue,
  RenderChildren,
} from "claude-code";

import type { Sandbox, TuiAction, TuiProps } from "../types";

type Mode = "normal" | "filter" | "exec" | "palette" | "confirm";
type Sort = "name" | "status" | "age";
type S = {
  cursor: string;
  filter: string;
  mode: Mode;
  exec: string;
  pal: number;
  palQuery: string;
  sort: Sort;
  scroll: number;
  note: string;
};

const INITIAL: S = {
  cursor: "",
  filter: "",
  mode: "normal",
  exec: "",
  pal: 0,
  palQuery: "",
  sort: "name",
  scroll: 0,
  note: "",
};
const SORTS: Sort[] = ["name", "status", "age"];
const SPECIAL_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "return",
  "tab",
  "backspace",
  "delete",
  "pageup",
  "pagedown",
  "home",
  "end",
  "escape",
  "insert",
]);

// rose-pine, as in the terma demo.
const C = {
  iris: "#c4a7e7",
  gold: "#f6c177",
  foam: "#9ccfd8",
  love: "#eb6f92",
  rose: "#ebbcba",
  muted: "#6e6a86",
  ink: "#191724",
};

type Item = { id: string; label: string; desc: string; key: string; run: () => void };

// Handlers must act on what the person last saw, not on the draw that
// registered them: an event can land between setState and the next draw.
// ponytail: module-level slots assume one TUI instance (the one pane).
let latestProps: TuiProps = { boxes: [], error: "", refreshedAt: "", busy: "", log: "" };
let pending: S | undefined;

export default function Tui(raw: JsonValue, surface: ClientSurface<S>) {
  latestProps = raw as unknown as TuiProps;
  pending = undefined;
  const { p, s, L, rows, cur, items } = ctx(surface);
  const { Box, Text } = surface.elements;

  surface.onKey((k: ClientKeyEvent) => onKey(k, ctx(surface)));
  surface.onPointer((e: ClientPointerEvent) => onPointer(e, ctx(surface)));

  return draw(p, s, L, rows, cur, items, Box, Text);
}

type Ctx = ReturnType<typeof ctx>;

function ctx(surface: ClientSurface<S>) {
  const p = latestProps;
  const s = pending ?? surface.state ?? INITIAL;
  const L = layout(surface.columns || 100, surface.rows || 30);
  const rows = visible(p.boxes, s);
  // The list holds every box on the account. With no explicit pick, select
  // this plugin's project box, else another box cos made — never a stranger's
  // box by accident (a stray d then y would destroy it).
  const picked = rows.findIndex((b) => b.id === s.cursor);
  const idx =
    picked >= 0
      ? picked
      : ([rows.findIndex((b) => b.name.startsWith("cos-proj-")), rows.findIndex(isOurs)].find(
          (i) => i >= 0,
        ) ?? -1);
  const cur = rows[idx];
  const set = (patch: Partial<S>) => {
    pending = { ...s, note: "", ...patch };
    surface.setState(pending);
  };
  const post = (a: TuiAction) => surface.post(a as unknown as JsonValue);
  const items = paletteItems(cur, s.mode === "palette" ? s.palQuery : "", post, set);
  const moveTo = (i: number) => {
    const n = Math.min(Math.max(0, i), Math.max(0, rows.length - 1));
    const scroll = n < s.scroll ? n : n >= s.scroll + L.visible ? n - L.visible + 1 : s.scroll;
    set({ cursor: rows[n]?.id ?? "", scroll });
  };
  const need = (ok: boolean | undefined, why: string, then: () => void) =>
    ok ? then() : set({ note: why });
  return { p, s, L, rows, idx, cur, set, post, items, moveTo, need };
}

function onKey(k: ClientKeyEvent, { s, L, rows, idx, cur, set, post, items, moveTo, need }: Ctx) {
  // Plain keys only. Every ctrl chord is already someone's: Claude Code takes
  // ctrl+g/t/o/r/s/f/x, Ghostty and tmux take ctrl+h/j/k/l, ctrl+s, ctrl+b.
  // Escape never reaches a Client (it hands focus back), so a field or the
  // palette closes on backspace when empty — no chord needed to back out.
  if (k.ctrl || k.meta) return;
  // A paste (or a fast burst) arrives as one key holding several characters,
  // and may carry tabs/newlines: a control character in a drawn Text blanks
  // the whole pane, so they become spaces before they reach state.
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  const text = (k.key === "space" ? " " : k.key).replace(/[\u0000-\u001f\u007f]+/g, " ");
  const char = text.length === 1 || !SPECIAL_KEYS.has(k.key) ? text : "";
  if (s.mode === "filter" || s.mode === "exec") {
    const field = s.mode === "filter" ? "filter" : "exec";
    if (k.key === "return") {
      if (s.mode === "exec" && cur && s.exec.trim()) post({ act: "exec", id: cur.id, cmd: s.exec });
      return set({ mode: "normal", ...(field === "exec" ? { exec: "" } : {}) });
    }
    if (k.key === "backspace")
      return s[field] === "" ? set({ mode: "normal" }) : set({ [field]: s[field].slice(0, -1) });
    if (char) return set({ [field]: s[field] + char, scroll: field === "filter" ? 0 : s.scroll });
    return;
  }
  if (s.mode === "palette") {
    if (k.key === "down") return set({ pal: (s.pal + 1) % Math.max(1, items.length) });
    if (k.key === "up") return set({ pal: (s.pal - 1 + items.length) % Math.max(1, items.length) });
    if (k.key === "return") return items[s.pal]?.run();
    if (k.key === "backspace")
      return s.palQuery === ""
        ? set({ mode: "normal" })
        : set({ palQuery: s.palQuery.slice(0, -1), pal: 0 });
    if (char) return set({ palQuery: s.palQuery + char, pal: 0 });
    return;
  }
  if (s.mode === "confirm") {
    // Only an explicit y destroys: a second d (a double tap) must not.
    if (cur && k.key === "y") post({ act: "down", id: cur.id });
    return set({ mode: "normal" });
  }
  if (k.key === ":") return set({ mode: "palette", pal: 0, palQuery: "" });
  switch (k.key) {
    case "j":
    case "down":
      return moveTo(idx + 1);
    case "k":
    case "up":
      return moveTo(idx - 1);
    case "g":
    case "home":
      return moveTo(0);
    case "G":
    case "end":
      return moveTo(rows.length - 1);
    case "pagedown":
      return moveTo(idx + L.visible);
    case "pageup":
      return moveTo(idx - L.visible);
    case "return":
      return set({ mode: "palette", pal: 0, palQuery: "" });
    case "/":
      return set({ mode: "filter" });
    case "o":
      return set({ sort: SORTS[(SORTS.indexOf(s.sort) + 1) % SORTS.length] });
    case "x":
      return need(cur?.status === "running", "exec needs a running box", () =>
        set({ mode: "exec" }),
      );
    case "d":
      return need(!!cur, "no box selected", () => set({ mode: "confirm" }));
    default: {
      const item = items.find((i) => i.key === k.key);
      if (item) return item.run();
      const anyItem = paletteItems(cur, "", post, set, true).find((i) => i.key === k.key);
      if (anyItem) set({ note: `${anyItem.label}: not available for this box` });
    }
  }
}

function onPointer(e: ClientPointerEvent, { s, L, rows, cur, set, items }: Ctx) {
  if (e.type !== "down" || e.button !== "left") return;
  if (s.mode === "palette") {
    const i = e.y - (L.palTop + 3);
    const inside = e.x >= L.palLeft && e.x < L.palLeft + L.palW;
    if (inside && i >= 0 && i < items.length) return items[i]!.run();
    if (!inside || e.y < L.palTop || e.y > L.palTop + 4 + items.length) set({ mode: "normal" });
    return;
  }
  if (e.x >= L.mainW) return;
  if (e.y >= L.filterY && e.y < L.filterY + 3) return set({ mode: "filter" });
  const r = e.y - (L.tableY + 2);
  if (r >= 0 && r < L.visible && s.scroll + r < rows.length) {
    const b = rows[s.scroll + r]!;
    return b.id === cur?.id
      ? set({ mode: "palette", pal: 0, palQuery: "" })
      : set({ cursor: b.id });
  }
  if (e.y >= L.outY && e.y < L.outY + L.outH && cur?.status === "running") set({ mode: "exec" });
}

function draw(
  p: TuiProps,
  s: S,
  L: ReturnType<typeof layout>,
  rows: Sandbox[],
  cur: Sandbox | undefined,
  items: Item[],
  Box: ClientSurface["elements"]["Box"],
  Text: ClientSurface["elements"]["Text"],
) {
  const running = p.boxes.filter((b) => b.status === "running").length;
  const paused = p.boxes.filter((b) => b.status === "paused").length;
  // Row: "▌ " + name + " status(9) shape(7) rgn(4) age(5) URL(3)" inside border+padding (4).
  const nameW = Math.max(8, L.mainW - 4 - 2 - (1 + 9 + 1 + 7 + 1 + 4 + 1 + 5 + 1 + 3));
  const logLines = p.log ? p.log.split("\n") : [];
  const outRoom = L.outH - 2 - (s.mode === "exec" ? 1 : 0);

  return (
    <Box flexDirection="column" width={L.W} height={L.H}>
      <Box flexDirection="row" height={1} marginRight={2}>
        <Text color={C.iris} bold>
          ≡ CreateOS Sandboxes
        </Text>
        {p.error ? (
          <Text color={C.love}> offline · {p.refreshedAt || "—"}</Text>
        ) : (
          <Text dimColor> live · {p.refreshedAt || "—"}</Text>
        )}
        <Box flexGrow={1} />
        {p.busy !== "" && <Text color={C.gold}>◐ {p.busy}… </Text>}
        <Text color={C.gold}>:</Text>
        <Text dimColor> actions click to focus</Text>
      </Box>

      <Box flexDirection="row" height={L.H - 2}>
        <Box flexDirection="column" width={L.mainW}>
          {panel(Box, Text, "Filter", s.mode === "filter", 3, [
            <Text key="f" color={s.filter ? undefined : C.muted}>
              ⌕ {s.filter || "Type / to filter by name, status, region…"}
              {s.mode === "filter" ? "█" : ""}
            </Text>,
          ])}
          {panel(
            Box,
            Text,
            `Sandboxes ${rows.length}/${p.boxes.length}`,
            s.mode === "normal",
            L.tableH,
            [
              <Text key="h" bold wrap="truncate">
                {"  "}
                {pad("Name", nameW)} {pad("Status", 9)} {pad("Shape", 7)} {pad("Rgn", 4)}{" "}
                {pad("Age", 5)} URL
              </Text>,
              ...(p.error
                ? [
                    <Text key="err" color={C.love}>
                      {p.error}
                    </Text>,
                  ]
                : []),
              ...(rows.length === 0 && !p.error
                ? [
                    <Text key="none" dimColor>
                      {p.boxes.length
                        ? "No match for the filter."
                        : "No active sandboxes. Press u to start one."}
                    </Text>,
                  ]
                : []),
              ...rows
                .slice(s.scroll, s.scroll + L.visible)
                .map((b) => row(Text, b, b.id === cur?.id, nameW, s.filter)),
            ],
          )}
          {panel(
            Box,
            Text,
            s.mode === "exec" && cur ? `Exec in ${cur.name}` : "Output",
            s.mode === "exec",
            L.outH,
            [
              ...logLines.slice(-Math.max(0, outRoom)).map((line, i) => (
                <Text
                  key={`l${i}`}
                  wrap="truncate"
                  color={
                    i === 0 && line.startsWith("ok ")
                      ? C.foam
                      : i === 0 && line.startsWith("fail")
                        ? C.love
                        : undefined
                  }
                  dimColor={i > 0}
                >
                  {line}
                </Text>
              )),
              ...(logLines.length === 0 && s.mode !== "exec"
                ? [
                    <Text key="hint" dimColor>
                      Press x to run a command in the selected box.
                    </Text>,
                  ]
                : []),
              ...(s.mode === "exec"
                ? [
                    <Text key="ex" color={C.gold}>
                      › {s.exec}█
                    </Text>,
                  ]
                : []),
            ],
          )}
        </Box>

        {L.side > 0 && (
          <Box flexDirection="column" width={L.side} marginLeft={1}>
            {panel(Box, Text, "Overview", false, 7, [
              kv(Text, "Running", String(running), C.foam),
              kv(Text, "Paused", String(paused), C.gold),
              kv(Text, "Showing", `${rows.length} of ${p.boxes.length}`),
              kv(Text, "Sort", s.sort, C.iris),
              kv(Text, "Mode", s.mode, C.iris),
            ])}
            {panel(
              Box,
              Text,
              "Details",
              false,
              L.H - 2 - 7 - 13,
              cur
                ? details(Text, cur, L.side - 4)
                : [
                    <Text key="n" dimColor>
                      Nothing selected.
                    </Text>,
                  ],
            )}
            {panel(
              Box,
              Text,
              "Keys",
              false,
              13,
              KEYS.map(([k, d]) => (
                <Box key={k} flexDirection="row">
                  <Text color={C.foam} bold>
                    {pad(k, 8)}
                  </Text>
                  <Text dimColor>{d}</Text>
                </Box>
              )),
            )}
          </Box>
        )}
      </Box>

      <Box flexDirection="row" height={1}>
        {s.note ? <Text color={C.love}>{s.note}</Text> : footer(Text, s.mode)}
      </Box>

      {s.mode === "palette" && (
        <Box
          position="absolute"
          top={L.palTop}
          left={L.palLeft}
          width={L.palW}
          flexDirection="column"
          borderStyle="round"
          borderColor={C.iris}
          backgroundColor={C.ink}
          paddingX={1}
        >
          <Text color={C.iris} bold>
            Actions{cur ? ` · ${cur.name}` : ""}
          </Text>
          <Text color={s.palQuery ? undefined : C.muted}>
            ⌕ {s.palQuery || "jump to an action…"}█
          </Text>
          {items.length === 0 && <Text dimColor>No action matches.</Text>}
          {items.map((it, i) => (
            <Box key={it.id} flexDirection="row" backgroundColor={i === s.pal ? C.gold : undefined}>
              <Text color={i === s.pal ? C.ink : C.foam} bold>
                {pad(it.key, 3)}
              </Text>
              <Text color={i === s.pal ? C.ink : undefined} bold={i === s.pal}>
                {pad(it.label, 14)}
              </Text>
              <Text color={i === s.pal ? C.ink : C.muted} wrap="truncate">
                {it.desc}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {s.mode === "confirm" && cur && (
        <Box
          position="absolute"
          top={L.palTop}
          left={L.palLeft}
          width={L.palW}
          flexDirection="column"
          borderStyle="round"
          borderColor={C.love}
          backgroundColor={C.ink}
          paddingX={1}
        >
          <Text color={C.love} bold>
            Destroy {cur.name}?
          </Text>
          <Text dimColor>{cur.id} — this cannot be undone.</Text>
          {!isOurs(cur) && (
            <Text color={C.gold} bold>
              This box was NOT made by this plugin — another tool or person may be using it.
            </Text>
          )}
          <Text>
            <Text color={C.love} bold>
              y
            </Text>{" "}
            destroy{" "}
            <Text color={C.foam} bold>
              any key
            </Text>{" "}
            cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}

// Every rectangle the tree draws, in cells, so clicks map back to rows.
export function layout(W: number, H: number) {
  const side = W >= 100 ? 34 : 0;
  const mainW = W - side - (side ? 1 : 0);
  const filterY = 1;
  const outH = 8;
  const tableY = filterY + 3;
  const tableH = Math.max(5, H - 1 - 3 - outH - 1);
  const palW = Math.min(64, W - 4);
  return {
    W,
    H,
    side,
    mainW,
    filterY,
    tableY,
    tableH,
    visible: tableH - 3,
    outY: tableY + tableH,
    outH,
    palTop: 3,
    palLeft: Math.max(0, Math.floor((W - palW) / 2)),
    palW,
  };
}

export function visible(boxes: Sandbox[], s: S) {
  const q = s.filter.toLowerCase();
  const by: Record<Sort, (a: Sandbox, b: Sandbox) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    status: (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
    age: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  };
  return boxes
    .filter(
      (b) => !q || `${b.name} ${b.status} ${b.region} ${b.shape} ${b.id}`.toLowerCase().includes(q),
    )
    .sort(by[s.sort]);
}

function paletteItems(
  cur: Sandbox | undefined,
  query: string,
  post: (a: TuiAction) => void,
  set: (patch: Partial<S>) => void,
  all = false,
): Item[] {
  const id = cur?.id ?? "";
  const run = (a: TuiAction) => () => {
    post(a);
    set({ mode: "normal" });
  };
  const items: (Item & { ok: boolean })[] = [
    {
      id: "exec",
      key: "x",
      label: "Exec",
      desc: "run a shell command in the box",
      ok: cur?.status === "running",
      run: () => set({ mode: "exec" }),
    },
    {
      id: "pause",
      key: "p",
      label: "Pause",
      desc: "snapshot it; zero compute while parked",
      ok: cur?.status === "running",
      run: run({ act: "pause", id }),
    },
    {
      id: "resume",
      key: "s",
      label: "Resume",
      desc: "bring the paused box back",
      ok: cur?.status === "paused",
      run: run({ act: "resume", id }),
    },
    {
      id: "fork",
      key: "f",
      label: "Fork",
      desc: "clone this paused box into a new one",
      ok: cur?.status === "paused",
      run: run({ act: "fork", id }),
    },
    {
      id: "expose",
      key: "e",
      label: cur?.ingress_enabled ? "Unexpose" : "Expose",
      desc: cur?.ingress_enabled ? "turn the public HTTPS URL off" : "give it a public HTTPS URL",
      ok: cur?.status === "running",
      run: run({ act: cur?.ingress_enabled ? "unexpose" : "expose", id }),
    },
    {
      id: "copy",
      key: "y",
      label: "Copy URL",
      desc: "copy the public URL template",
      ok: !!cur?.ingress_enabled && !!cur.ingress_url_template,
      run: run({ act: "copy", id }),
    },
    {
      id: "down",
      key: "d",
      label: "Down",
      desc: "destroy the box (asks first)",
      ok: !!cur,
      run: () => set({ mode: "confirm" }),
    },
    {
      id: "up",
      key: "u",
      label: "Up",
      desc: "create or reuse the project box (cos up)",
      ok: true,
      run: run({ act: "up" }),
    },
    {
      id: "refresh",
      key: "r",
      label: "Refresh",
      desc: "re-read the sandbox list",
      ok: true,
      run: run({ act: "refresh" }),
    },
  ];
  const q = query.toLowerCase();
  return items.filter(
    (i) => (all || i.ok) && (!q || `${i.label} ${i.desc}`.toLowerCase().includes(q)),
  );
}

const KEYS: [string, string][] = [
  ["↑↓ jk", "move"],
  ["enter", "actions for box"],
  ["/", "filter"],
  ["x", "exec command"],
  ["p s", "pause / resume"],
  ["f e", "fork / expose"],
  ["d", "down (asks)"],
  ["u r", "up / refresh"],
  ["o", "cycle sort"],
  [":", "action palette"],
  ["⌫", "close (when empty)"],
];

function footer(Text: ClientSurface["elements"]["Text"], mode: Mode) {
  const hints: Record<Mode, [string, string][]> = {
    normal: [
      ["/", "Filter"],
      ["x", "Exec"],
      ["p", "Pause"],
      ["s", "Resume"],
      ["d", "Down"],
      ["u", "Up"],
      ["o", "Sort"],
      [":", "Actions"],
    ],
    filter: [
      ["type", "to filter"],
      ["enter", "Keep"],
      ["⌫", "Erase / close"],
    ],
    exec: [
      ["type", "a command"],
      ["enter", "Run"],
      ["⌫", "Erase / cancel"],
    ],
    palette: [
      ["↑↓", "Choose"],
      ["enter", "Run"],
      ["type", "to search"],
      ["⌫", "Close"],
    ],
    confirm: [
      ["y", "Destroy"],
      ["any key", "Cancel"],
    ],
  };
  return hints[mode].flatMap(([k, d]) => [
    <Text key={`k${k}`} color={C.gold}>
      {k}
    </Text>,
    <Text key={`d${k}`} dimColor>{` ${d}  `}</Text>,
  ]);
}

function panel(
  Box: ClientSurface["elements"]["Box"],
  Text: ClientSurface["elements"]["Text"],
  title: string,
  isActive: boolean,
  height: number,
  children: RenderChildren[],
) {
  // The title sits on the top border, drawn over it from an unclipped wrapper:
  // the bordered box itself clips its overflow, which would hide it.
  return (
    <Box key={title} flexDirection="column" height={Math.max(3, height)}>
      <Box
        flexDirection="column"
        height={Math.max(3, height)}
        borderStyle="round"
        borderColor={isActive ? C.iris : C.muted}
        paddingX={1}
        overflow="hidden"
      >
        {children}
      </Box>
      <Box position="absolute" top={0} left={2}>
        <Text color={isActive ? C.iris : C.rose} bold>
          {" "}
          {title}{" "}
        </Text>
      </Box>
    </Box>
  );
}

function row(
  Text: ClientSurface["elements"]["Text"],
  b: Sandbox,
  isCur: boolean,
  nameW: number,
  filter: string,
) {
  const bg = isCur ? C.gold : undefined;
  const fg = isCur ? C.ink : undefined;
  const statusColor = isCur
    ? C.ink
    : b.status === "running"
      ? C.foam
      : b.status === "paused"
        ? C.gold
        : b.status === "failed"
          ? C.love
          : C.iris;
  const name = pad(b.name, nameW);
  const at = filter ? name.toLowerCase().indexOf(filter.toLowerCase()) : -1;
  return (
    <Text
      key={b.id}
      backgroundColor={bg}
      color={fg}
      dimColor={!isCur && !isOurs(b)}
      wrap="truncate"
    >
      {isCur ? "▌ " : "  "}
      {at < 0
        ? name
        : [
            name.slice(0, at),
            <Text key="m" underline bold color={isCur ? C.ink : C.gold}>
              {name.slice(at, at + filter.length)}
            </Text>,
            name.slice(at + filter.length),
          ]}{" "}
      <Text color={statusColor} backgroundColor={bg}>
        {pad(b.status, 9)}
      </Text>{" "}
      {pad(`${b.vcpu}c/${Math.round(b.mem_mib / 1024)}g`, 7)} {pad(b.region, 4)}{" "}
      {pad(age(b.running_at || b.created_at), 5)} {b.ingress_enabled ? "●" : "–"}
    </Text>
  );
}

function details(Text: ClientSurface["elements"]["Text"], b: Sandbox, w: number) {
  return [
    <Text key="n" bold>
      {pad(b.name, w)}
    </Text>,
    kv(Text, "Made by", isOurs(b) ? "this plugin" : "another tool", isOurs(b) ? C.foam : C.gold),
    kv(Text, "ID", b.id.replace(/^sb-/, "")),
    kv(Text, "IP", b.ip || "—"),
    kv(Text, "Shape", b.shape),
    kv(Text, "Image", b.rootfs),
    kv(Text, "Region", b.region),
    kv(Text, "Age", age(b.running_at || b.created_at)),
    ...(b.ingress_enabled && b.ingress_url_template
      ? [
          <Text key="u" color={C.foam} wrap="wrap">
            {b.ingress_url_template}
          </Text>,
        ]
      : []),
  ];
}

function kv(Text: ClientSurface["elements"]["Text"], k: string, v: string, color?: string) {
  return (
    <Text key={k} wrap="truncate">
      <Text dimColor>{pad(k, 8)}</Text>
      <Text color={color} bold={!!color}>
        {v}
      </Text>
    </Text>
  );
}

function age(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

// Every box the cos driver creates is named cos-* (cos-proj-*, cos-o-*, cos-x-*, ...).
const isOurs = (b: Sandbox) => b.name.startsWith("cos-");

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
