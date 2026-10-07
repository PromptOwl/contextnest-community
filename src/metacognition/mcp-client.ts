/**
 * The metacognition agent's MCP client: Streamable HTTP to the servers its
 * config names, calling only the tools its config allows.
 *
 * One connection per server per run, opened on first use and closed when the
 * run ends. Every URL passes the SSRF fence again at connect time (the config
 * was checked when saved, but a config can outlive a policy change), and the
 * transport's fetch refuses redirects so a public URL can't bounce the server
 * onto a private address.
 *
 * `setMcpConnector` is the seam tests use to stand in for a real server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { urlAllowed, type McpServerConfig } from "./config.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpConnection {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export type McpConnector = (server: McpServerConfig, token: string | null) => Promise<McpConnection>;

const TIMEOUT_MS = 30_000;
/** Cap on the text one tool call hands back to the model. */
export const MAX_RESULT_CHARS = 20_000;

const realConnector: McpConnector = async (server, token) => {
  if (!urlAllowed(server.url)) throw new Error(`MCP server "${server.name}" has a URL this server may not call`);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  const client = new Client({ name: "contextnest-metacognition", version: "1.0.0" });
  await client.connect(transport, { timeout: TIMEOUT_MS });
  return {
    async listTools() {
      const res = await client.listTools(undefined, { timeout: TIMEOUT_MS });
      return res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },
    async callTool(name, args) {
      const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS })) as {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const text =
        (res.content ?? [])
          .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content omitted]`))
          .join("\n") || (res.structuredContent !== undefined ? JSON.stringify(res.structuredContent) : "");
      return { text: text.slice(0, MAX_RESULT_CHARS), isError: !!res.isError };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
};

let connector: McpConnector = realConnector;

/** Tests only: replace how connections are made (null restores the real one). */
export function setMcpConnector(fn: McpConnector | null): void {
  connector = fn ?? realConnector;
}

/** Per-run pool: one connection per server, all closed by `closeAll`. */
export class McpPool {
  private open = new Map<string, Promise<McpConnection>>();
  constructor(private readonly tokenFor: (server: McpServerConfig) => string | null) {}

  get(server: McpServerConfig): Promise<McpConnection> {
    let c = this.open.get(server.name);
    if (!c) {
      c = connector(server, this.tokenFor(server));
      // A failed connect must not poison the pool for the rest of the run.
      c.catch(() => this.open.delete(server.name));
      this.open.set(server.name, c);
    }
    return c;
  }

  async closeAll(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => {})));
  }
}
