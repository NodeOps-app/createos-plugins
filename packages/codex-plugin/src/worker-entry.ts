import { JobStore } from "./jobs.ts";
import { runJob } from "./worker.ts";

const [dataDirectory, workspace, id] = process.argv.slice(2);
if (!dataDirectory || !workspace || !id) throw new Error("Missing worker arguments");
await runJob(new JobStore(dataDirectory, workspace), id);
