import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const { server } = createServer();
await server.connect(new StdioServerTransport());
