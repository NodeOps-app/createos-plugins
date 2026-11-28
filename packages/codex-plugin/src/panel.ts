import { App } from "@modelcontextprotocol/ext-apps";
import type { Job } from "./jobs.ts";

const app = new App({ name: "CreateOS Sandbox", version: "0.3.0" }, {});
const element = (id: string) => document.getElementById(id)!;
let selected: string | undefined;
let jobs: Job[] = [];
let busy = false;
let pendingRefresh = false;
let pendingContext = false;

function error(message: string) { element("error").textContent = message; }
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.filter((item) => item.type === "text").map((item) => item.text).join(" ") || "Request failed");
  return { ...result, structuredContent: (result.structuredContent ?? {}) as Record<string, unknown> };
}

function render(job?: Job) {
  element("jobs").replaceChildren();
  for (const item of jobs) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${item.status} · ${item.command}`;
    button.title = item.command;
    button.setAttribute("aria-pressed", String(item.id === selected));
    button.onclick = () => { selected = item.id; void refresh(true); };
    element("jobs").append(button);
  }
  element("empty").hidden = jobs.length > 0;
  element("empty").textContent = "No jobs yet. Ask ChatGPT to run a task in a CreateOS sandbox.";
  element("detail").hidden = !job;
  if (!job) return;
  element("status").textContent = job.status === "failed" && job.kept ? "Needs recovery · sandbox retained" : `${job.status}${job.exitCode === undefined ? "" : ` · exit ${job.exitCode}`}`;
  element("command").textContent = job.command;
  element("meta").textContent = `${job.id} · ${job.sandboxId ?? "Waiting for sandbox"} · network ${job.network ?? "denied"}`;
  element("warnings").textContent = job.warnings.join("\n");
  element("artifacts").replaceChildren();
  for (const artifact of job.artifacts) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Download ${artifact.name} (${Math.ceil(artifact.bytes / 1024)} KiB)`;
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await call("download_artifact", { jobId: job.id, name: artifact.name });
        const link = result.content.find((item) => item.type === "resource_link");
        if (!link || link.type !== "resource_link") throw new Error("No artifact resource returned");
        const resource = await app.readServerResource({ uri: link.uri });
        const download = await app.downloadFile({ contents: resource.contents.map((item) => ({ type: "resource" as const, resource: item })) });
        if (download.isError) throw new Error("Download was declined or is not supported by this host");
      } catch (cause) { error(cause instanceof Error ? cause.message : String(cause)); }
      finally { button.disabled = false; }
    };
    element("artifacts").append(button);
  }
}

async function refresh(shareContext = false) {
  if (busy) {
    pendingRefresh = true;
    pendingContext ||= shareContext;
    return;
  }
  busy = true;
  (element("refresh") as HTMLButtonElement).disabled = true;
  try {
    const result = await call("list_jobs");
    jobs = (result.structuredContent?.jobs as Job[]) ?? [];
    if (!selected || !jobs.some((job) => job.id === selected)) selected = jobs[0]?.id;
    const job = jobs.find((item) => item.id === selected);
    render(job);
    if (job) {
      const logs = await call("get_job_logs", { jobId: job.id });
      element("log").textContent = String(logs.structuredContent?.log ?? "");
      if (shareContext) await app.updateModelContext({ content: [{ type: "text", text: `The user selected CreateOS job ${job.id}, sandbox ${job.sandboxId ?? "pending"}, status ${job.status}. Use this job for subsequent questions about the selected run.` }] });
    }
    error("");
  } catch (cause) { error(cause instanceof Error ? cause.message : String(cause)); }
  finally {
    busy = false;
    (element("refresh") as HTMLButtonElement).disabled = false;
    if (pendingRefresh) {
      const share = pendingContext;
      pendingRefresh = false;
      pendingContext = false;
      void refresh(share);
    }
  }
}

app.ontoolresult = (result) => {
  const job = (result.structuredContent as Record<string, unknown> | undefined)?.job as Job | undefined;
  if (job) selected = job.id;
  void refresh();
};
app.onhostcontextchanged = ({ theme }) => { if (theme) document.documentElement.style.colorScheme = theme; };
element("refresh").onclick = () => void refresh();
try {
  await app.connect();
  document.documentElement.style.colorScheme = app.getHostContext()?.theme ?? "light dark";
  await refresh();
  setInterval(() => { if (jobs.some((job) => !["succeeded", "failed"].includes(job.status))) void refresh(); }, 5_000);
} catch {
  error("Open this panel through a connected CreateOS plugin in an MCP Apps host.");
  element("empty").hidden = true;
}
