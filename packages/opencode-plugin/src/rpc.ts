import { Rpc } from "@opencode/plugin/rpc";

const session = {
  type: "object",
  properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

const sessionErrors = {
  session_unavailable: session,
  location_mismatch: session,
} as const;

/** Importable without loading the plugin implementation or allocating compute. */
export const CreateOS = Rpc.define({
  id: "createos",
  events: {},
  methods: {
    status: { input: session, output: { type: "object" }, errors: sessionErrors },
    release: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 }, destroy: { type: "boolean" } },
        required: ["sessionID", "destroy"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { released: { type: "boolean" } },
        required: ["released"],
      },
      errors: {
        ...sessionErrors,
        release_failed: {
          type: "object",
          properties: { sessionID: { type: "string", minLength: 1 }, destroy: { type: "boolean" } },
          required: ["sessionID", "destroy"],
          additionalProperties: false,
        },
      },
    },
  },
});
