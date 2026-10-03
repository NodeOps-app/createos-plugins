// One row of `createos -o json sandbox ls`, trimmed to what the dashboard draws.
export type Sandbox = {
  id: string;
  name: string;
  status: string;
  ip: string;
  vcpu: number;
  mem_mib: number;
  shape: string;
  rootfs: string;
  region: string;
  created_at: string;
  running_at?: string;
  ingress_enabled: boolean;
  ingress_url_template?: string;
};

export type DashboardView = {
  boxes: Sandbox[];
  error: string;
  refreshedAt: string;
};

// What the hooks module hands the TUI (a Client surface module) as props.
export type TuiProps = DashboardView & { busy: string; log: string };

// What the TUI posts back; the hooks module validates it before acting.
export type TuiAction =
  | { act: "up" | "refresh" }
  | { act: "pause" | "resume" | "fork" | "expose" | "unexpose" | "down" | "copy"; id: string }
  | { act: "exec"; id: string; cmd: string };

declare module "claude-code" {
  interface PluginState {
    "createos-sandbox": {
      view: DashboardView;
      busy: string;
      log: string;
    };
  }
}
