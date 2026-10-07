/**
 * A metacognition agent's configuration, as stored in
 * metacognition_agents.config_json and accepted by PUT /metacognition/:node.
 *
 * Everything here bounds what an autonomous loop may do, so it is validated
 * strictly and clamped to server ceilings: unknown keys are dropped, every
 * URL must pass the same SSRF fence outbound connectors use, and an MCP
 * server must name the tools the agent may call (deny by default — a feed or
 * an MCP result can carry instructions, and the only defence that doesn't
 * depend on the model obeying is not handing it a tool that acts).
 */
import { ValidationError } from "../shared/errors.js";
import { isSafeConnectorUrl } from "../notify/dispatch.js";
import { config } from "../config.js";

export interface FeedConfig {
  name: string;
  url: string;
}

export interface McpServerConfig {
  name: string;
  url: string;
  /** Tools the agent may call on this server. Required, non-empty. */
  allowed_tools: string[];
  /** Name of a nest env value holding a bearer token for this server. */
  auth_env?: string;
}

export interface MetacognitionConfig {
  persona: { name: string; avatar: string | null };
  /** Folders (under nodes/) the persona may read, and propose changes in.
   *  read: empty = the whole nest. propose: empty = nowhere, ["*"] = wherever
   *  it may read; named folders must sit inside read. */
  scope: { read: string[]; propose: string[] };
  caps: {
    /** Model turns per run. */
    max_steps: number;
    /** Input + output tokens per run, cache reads included. */
    max_tokens: number;
    /** Wall-clock seconds per run. */
    max_seconds: number;
    /** Proposals (edits + new documents) per run. */
    max_proposals: number;
  };
  feeds: FeedConfig[];
  mcp_servers: McpServerConfig[];
  /** Model override; default is the nest's Hootie model. */
  model: string | null;
}

/** Defaults, and the ceilings no config can exceed. */
export const CAPS = {
  max_steps: { default: 12, min: 1, max: 50 },
  max_tokens: { default: 300_000, min: 10_000, max: 2_000_000 },
  max_seconds: { default: 300, min: 10, max: 1_800 },
  max_proposals: { default: 5, min: 0, max: 20 },
} as const;

const NAME_RE = /^[A-Za-z0-9][\w .'-]{0,59}$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new ValidationError(`${field} is required`);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${field} is too long (max ${max})`);
  return s;
}

function folders(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50) throw new ValidationError(`${field} must be a list of folders`);
  return [
    ...new Set(
      v.map((f) => {
        const s = str(f, field, 200).replace(/^nodes\//, "").replace(/^\/+|\/+$/g, "");
        if (!s || s.split("/").some((seg) => seg === "." || seg === ".." || !seg)) {
          throw new ValidationError(`${field}: "${f}" is not a folder`);
        }
        return s;
      }),
    ),
  ];
}

function clamp(v: unknown, cap: { default: number; min: number; max: number }, field: string): number {
  if (v === undefined || v === null) return cap.default;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number`);
  return Math.min(cap.max, Math.max(cap.min, n));
}

function url(v: unknown, field: string): string {
  const s = str(v, field, 500);
  const ok = config.METACOGNITION_ALLOW_PRIVATE_URLS
    ? /^https?:\/\//i.test(s)
    : isSafeConnectorUrl(s);
  if (!ok) {
    throw new ValidationError(
      `${field} must be a public https URL (no localhost, private or link-local addresses)`,
    );
  }
  return s;
}

/** Can a URL stored earlier still be fetched? Re-checked at call time too. */
export function urlAllowed(raw: string): boolean {
  return config.METACOGNITION_ALLOW_PRIVATE_URLS ? /^https?:\/\//i.test(raw) : isSafeConnectorUrl(raw);
}

export function parseConfig(input: unknown): MetacognitionConfig {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const persona = (b.persona ?? {}) as Record<string, unknown>;
  const name = str(persona.name, "persona.name", 60);
  if (!NAME_RE.test(name)) {
    throw new ValidationError("persona.name may use letters, numbers, spaces and . ' - _");
  }
  const avatar =
    persona.avatar === undefined || persona.avatar === null || persona.avatar === ""
      ? null
      : str(persona.avatar, "persona.avatar", 500);

  const read = folders(b.scope?.read, "scope.read");
  // "*" = anywhere it may read. Empty = proposals off: an agent that may
  // change things has to be told where, never get it by default.
  const proposeIn = Array.isArray(b.scope?.propose) ? b.scope.propose : b.scope?.propose;
  const anywhere = Array.isArray(proposeIn) && proposeIn.some((p: unknown) => p === "*");
  if (anywhere && proposeIn.length > 1) throw new ValidationError('scope.propose: "*" stands alone');
  const propose = anywhere ? ["*"] : folders(proposeIn, "scope.propose");
  // A folder the persona may propose in must be one it may read: proposing
  // blind is how an agent overwrites what it never saw.
  if (read.length && !anywhere) {
    for (const p of propose) {
      if (!read.some((r) => p === r || p.startsWith(`${r}/`))) {
        throw new ValidationError(`scope.propose "${p}" is outside scope.read`);
      }
    }
  }

  const caps = b.caps ?? {};
  const feedsIn = b.feeds ?? [];
  const mcpIn = b.mcp_servers ?? [];
  if (!Array.isArray(feedsIn) || feedsIn.length > 20) throw new ValidationError("feeds must be a list (max 20)");
  if (!Array.isArray(mcpIn) || mcpIn.length > 10) throw new ValidationError("mcp_servers must be a list (max 10)");

  const feeds = feedsIn.map((f: any, i: number) => {
    const n = str(f?.name, `feeds[${i}].name`, 40);
    if (!KEY_RE.test(n)) throw new ValidationError(`feeds[${i}].name may use letters, numbers, - and _`);
    return { name: n, url: url(f?.url, `feeds[${i}].url`) };
  });
  const mcp_servers = mcpIn.map((m: any, i: number) => {
    const n = str(m?.name, `mcp_servers[${i}].name`, 40);
    if (!KEY_RE.test(n)) throw new ValidationError(`mcp_servers[${i}].name may use letters, numbers, - and _`);
    const tools = m?.allowed_tools;
    if (!Array.isArray(tools) || tools.length === 0 || tools.length > 50) {
      throw new ValidationError(
        `mcp_servers[${i}].allowed_tools must name the tools the agent may call (at least one)`,
      );
    }
    const auth_env =
      m?.auth_env === undefined || m?.auth_env === null || m?.auth_env === ""
        ? undefined
        : str(m.auth_env, `mcp_servers[${i}].auth_env`, 100);
    // Only env values named for this purpose can be sent out as a bearer
    // token: an agent config must not be able to ship the nest's model key or
    // a connector secret to a URL of its choosing.
    if (auth_env && !/^MCP_[A-Z0-9_]{1,60}$/.test(auth_env)) {
      throw new ValidationError(`mcp_servers[${i}].auth_env must be an env name starting MCP_ (e.g. MCP_DESK_TOKEN)`);
    }
    return {
      name: n,
      url: url(m?.url, `mcp_servers[${i}].url`),
      allowed_tools: [...new Set(tools.map((t: unknown) => str(t, `mcp_servers[${i}].allowed_tools`, 100)))],
      ...(auth_env ? { auth_env } : {}),
    };
  });
  for (const list of [feeds, mcp_servers]) {
    const names = list.map((x) => x.name);
    if (new Set(names).size !== names.length) throw new ValidationError("feed and MCP server names must be unique");
  }

  return {
    persona: { name, avatar },
    scope: { read, propose },
    caps: {
      max_steps: clamp(caps.max_steps, CAPS.max_steps, "caps.max_steps"),
      max_tokens: clamp(caps.max_tokens, CAPS.max_tokens, "caps.max_tokens"),
      max_seconds: clamp(caps.max_seconds, CAPS.max_seconds, "caps.max_seconds"),
      max_proposals: clamp(caps.max_proposals, CAPS.max_proposals, "caps.max_proposals"),
    },
    feeds,
    mcp_servers,
    model:
      b.model === undefined || b.model === null || b.model === ""
        ? null
        : (() => {
            const m = str(b.model, "model", 128);
            if (!/^[\w./:@-]+$/.test(m)) throw new ValidationError("model is not a model name");
            return m;
          })(),
  };
}

/**
 * May the agent propose at this node id? Empty `propose` = nowhere; ["*"] =
 * anywhere inside its read scope; otherwise inside the named folders (which
 * the config already holds inside `read`).
 */
export function mayProposeIn(nodeId: string, scope: { read: string[]; propose: string[] }): boolean {
  if (!scope.propose.length) return false;
  if (scope.propose[0] === "*") return inFolders(nodeId, scope.read);
  return inFolders(nodeId, scope.propose);
}

/** Is this node id inside one of these folders? Empty list = everywhere. */
export function inFolders(nodeId: string, list: string[]): boolean {
  if (!list.length) return true;
  const rel = nodeId.replace(/^nodes\//, "");
  return list.some((f) => rel.startsWith(`${f}/`));
}
