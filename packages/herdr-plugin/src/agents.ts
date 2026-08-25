export type Agent = {
  title: string;
  /** HERDR_AGENT value, so Herdr classifies the pane. null = no detection. */
  detect: string | null;
  /** Binary name resolved with `command -v` inside the sandbox after install. */
  bin: string;
  /** Official installer, run in a login shell inside the sandbox. */
  install: string | null;
};

export const AGENTS: Record<string, Agent> = {
  "claude-code": {
    title: "Claude Code",
    detect: "claude",
    bin: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: {
    title: "Codex",
    detect: "codex",
    bin: "codex",
    install: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
  },
  opencode: {
    title: "OpenCode",
    detect: "opencode",
    bin: "opencode",
    install: "curl -fsSL https://opencode.ai/install | bash",
  },
  pi: {
    title: "Pi",
    detect: "pi",
    bin: "pi",
    install: "curl -fsSL https://pi.dev/install.sh | sh",
  },
  cursor: {
    title: "Cursor",
    detect: "cursor",
    bin: "cursor-agent",
    install: "curl https://cursor.com/install -fsS | bash",
  },
  shell: { title: "Shell", detect: null, bin: "bash", install: null },
};

/** Installers drop binaries in several places; a login shell alone misses some. */
export const REMOTE_PATH =
  "$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.cursor/bin:$HOME/.pi/bin:$HOME/.codex/bin:$HOME/.bun/bin:$PATH";
