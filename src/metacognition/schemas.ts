/**
 * The JSON Schema of a metacognition agent's config — the PUT
 * /nests/:id/metacognition/:node body — and of the operations on one, kept
 * next to parseConfig (config.ts), the parser it describes.
 *
 * The MCP tools (mcp/metacognition-tools.ts) take their input schemas from
 * here. Metacognition is this edition's own feature (server-run agents, the
 * metacognition_agents table): there is no engine operation to import a
 * descriptor from, so the contract lives with the code that enforces it.
 * The schema only advertises shapes; parseConfig is what validates, so a
 * field described here and refused there answers with parseConfig's message.
 */

const AGENT_REF = {
  type: "string",
  description: 'Node id of the agent document, e.g. "nodes/archivist" (metacognition_list shows them).',
} as const;

/** The PUT body's fields. */
export const CONFIG_PROPERTIES = {
  persona: { type: "object", description: "{ name, avatar? } — avatar is an emoji or up to 4 letters" },
  scope: {
    type: "object",
    description: '{ read: string[] ([] = whole nest), propose: string[] ([] = comments only, ["*"] = anywhere it reads) }',
  },
  caps: { type: "object", description: "{ max_steps?, max_tokens?, max_seconds?, max_proposals?, max_comments? }" },
  feeds: { type: "array", items: { type: "object" }, description: "[{ name, url }] — public https feeds it reads as untrusted data" },
  mcp_servers: { type: "array", items: { type: "object" }, description: "[{ name, url, allowed_tools: string[], auth_env? }]" },
  model: { type: "string", description: "Model override (default: the nest's Hootie model)" },
  enabled: { type: "boolean", description: "false keeps the settings but stops it running (default true)" },
} as const;

export const METACOGNITION_INPUT_SCHEMAS = {
  list: { type: "object", properties: {}, required: [] as string[] },
  configure: {
    type: "object",
    properties: {
      agent: AGENT_REF,
      ...CONFIG_PROPERTIES,
      dry_run: { type: "boolean", description: "true = validate and summarize, save nothing. Do this first. Must be a JSON boolean." },
    },
    required: ["agent"],
  },
  run: {
    type: "object",
    properties: {
      agent: AGENT_REF,
      inputs: { type: "object", description: "Optional request for this run; the agent treats it as a request to consider, not as instructions" },
    },
    required: ["agent"],
  },
  remove: { type: "object", properties: { agent: AGENT_REF }, required: ["agent"] },
};
