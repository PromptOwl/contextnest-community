/**
 * Public links over MCP (PO-1365): publish one document at /p/<slug>, list a
 * document's links, revoke one. The twins of POST / GET / DELETE
 * /nests/:nestId/publications (nests/publish-routes.ts), on the same service
 * (nests/publish-service.ts), so a link made by an agent is the link the
 * Publish dialog shows and the other way round.
 *
 * Community-only: a publish is server state (the `publish` and `access_grant`
 * tables, the /p render surface) that the engine does not model, so there is
 * no engine descriptor to import — see scripts/check-mcp-schemas.mjs.
 *
 * Who may call them is who may use the REST routes: the nest's owner, a nest
 * admin, or the server admin (canManageStewards), re-checked on every call.
 * They are MCP_ADMIN_TOOLS, so they are advertised only to those people on a
 * read-write credential, like every other admin tool on this endpoint.
 */
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { canManageStewards } from "../governance/stewardship-service.js";
import { getApprovedVersion } from "../governance/version-service.js";
import {
  PUBLISH_FORBIDDEN,
  PUBLISH_NOT_FOUND,
  getPublishById,
  isLivePublish,
  listAllowlist,
  listPublish,
  publishDocumentLink,
  revokePublish,
  toPublishResponse,
  type PublishMode,
  type PublishRow,
} from "../nests/publish-service.js";
import type { McpToolContext, ToolResult } from "./tools.js";

const MODE_ENUM = ["public", "code", "email", "invite"];

export const PUBLIC_LINK_TOOL_DEFINITIONS = [
  {
    name: "context_public_link_create",
    description:
      "Publish one document as a hosted page at its own link and return the URL. Nest owners/admins only. This puts the document's APPROVED version on the internet: with access_mode public (the default) anyone who has the link can read it without signing in — confirm with the user first. code = one shared passcode; email = the reader confirms an email address and gets a one-time link; invite = only the listed addresses, who are emailed the link. Later approved versions appear at the same link; drafts never do. A document with no approved version is refused. Mirrors POST /nests/:id/publications.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: 'Document id, e.g. "nodes/handbook".' },
        access_mode: {
          type: "string",
          enum: MODE_ENUM,
          description: "Who can open the link. Default public: anyone with the link.",
        },
        code: { type: "string", description: "The passcode readers type (access_mode code)." },
        allowlist: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses that may open the link (access_mode invite). Each is emailed the link.",
        },
        expires_at: { type: "string", description: "ISO date-time after which the link stops working. Omit for no expiry." },
        comments_enabled: { type: "boolean", description: "Let readers leave comments, which go to the document's stewards. Default false." },
        watermark: { type: "boolean", description: "Stamp the reader's email across the page (email and invite links only). Default false." },
        no_download: { type: "boolean", description: "Discourage copying and printing. Default false." },
      },
      required: ["id"],
    },
  },
  {
    name: "context_public_links",
    description:
      "List the public links of this nest's documents: each link's URL, whether it is open or gated, and whether it still works. Nest owners/admins only. Pass id to see one document's links — check this before creating a link, so an existing one is reused. Mirrors GET /nests/:id/publications.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: 'Document id to list links for, e.g. "nodes/handbook". Omit for every link in the nest.' },
      },
    },
  },
  {
    name: "context_public_link_revoke",
    description:
      "Revoke a public link, so its URL stops working for everyone at once. Nest owners/admins only. The document itself is not changed, and a revoked link cannot be restored — publishing again gives a new URL. Mirrors DELETE /nests/:id/publications/:id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        link_id: { type: "string", description: "The link's id, from context_public_links or context_public_link_create." },
      },
      required: ["link_id"],
    },
  },
];

export const PUBLIC_LINK_TOOL_NAMES = PUBLIC_LINK_TOOL_DEFINITIONS.map((t) => t.name);

export function isPublicLinkTool(name: string): boolean {
  return PUBLIC_LINK_TOOL_NAMES.includes(name);
}

/** The same error shape mcp/tools.ts gives a refusal: prose plus `{code, message}`. */
function refusal(text: string, code: "UNAUTHORIZED_ACTION" | "VALIDATION_FAILED" | "DOCUMENT_NOT_FOUND"): ToolResult {
  return { text, isError: true, data: { code, message: text } };
}

/** Whether a link needs anything beyond the URL to open, in the words a
 *  person would use. Never includes the passcode. */
function gate(mode: PublishMode, invited = 0): { access: "open" | "gated"; says: string } {
  switch (mode) {
    case "public":
      return { access: "open", says: "open — anyone with the link can read it, without signing in" };
    case "code":
      return { access: "gated", says: "gated — readers need the passcode you set" };
    case "email":
      return { access: "gated", says: "gated — readers confirm an email address and get a one-time link" };
    case "invite":
      return {
        access: "gated",
        says: `gated — invite only${invited ? ` (${invited} ${invited === 1 ? "person" : "people"}, each emailed the link)` : ""}`,
      };
  }
}

function describeRow(row: PublishRow, baseUrl: string) {
  const { access, says } = gate(row.access_mode);
  const live: boolean = isLivePublish(row);
  const link = `${baseUrl}/p/${row.slug}`;
  const state = live ? says : `${row.revoked_at ? "revoked" : "expired"}, no longer works`;
  const until = live && row.expires_at ? `, until ${row.expires_at}` : "";
  return {
    data: { ...toPublishResponse(row), link, access, live },
    line: `- ${row.node_id}: ${link} — ${state}${until} (link_id ${row.id})`,
  };
}

export async function runPublicLinkTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  if (!(await canManageStewards(ctx.nestId, ctx.userId))) {
    return refusal(PUBLISH_FORBIDDEN, "UNAUTHORIZED_ACTION");
  }
  const baseUrl = ctx.baseUrl ?? "";
  try {
    if (toolName === "context_public_links") {
      const nodeId = typeof args.id === "string" ? args.id.trim() : "";
      const rows = (await listPublish(ctx.nestId)).filter((r) => !nodeId || r.node_id === nodeId);
      const described = rows.map((r) => describeRow(r, baseUrl));
      const data = { count: rows.length, publishes: described.map((d) => d.data) };
      if (!rows.length) {
        return {
          text: nodeId
            ? `${nodeId} has no public link. context_public_link_create makes one.`
            : "This nest has no public links.",
          data,
        };
      }
      const liveCount = described.filter((d) => d.data.live).length;
      return {
        text: `${rows.length} public link${rows.length === 1 ? "" : "s"}${nodeId ? ` for ${nodeId}` : ""}, ${liveCount} working:\n${described.map((d) => d.line).join("\n")}`,
        data,
      };
    }

    if (toolName === "context_public_link_create") {
      const { row, link } = await publishDocumentLink({
        nestId: ctx.nestId,
        userId: ctx.userId,
        baseUrl,
        request: {
          node_id: typeof args.id === "string" ? args.id : "",
          access_mode: typeof args.access_mode === "string" ? args.access_mode : undefined,
          comments_enabled: args.comments_enabled === true,
          watermark: args.watermark === true,
          no_download: args.no_download === true,
          code: typeof args.code === "string" ? args.code : null,
          allowlist: Array.isArray(args.allowlist) ? args.allowlist.map(String) : [],
          expires_at: typeof args.expires_at === "string" && args.expires_at ? args.expires_at : null,
        },
      });
      const invited = row.access_mode === "invite" ? (await listAllowlist(row.id)).length : 0;
      const { access, says } = gate(row.access_mode, invited);
      const version = await getApprovedVersion(ctx.nestId, row.node_id);
      return {
        text: [
          `Published ${row.node_id}.`,
          `Public URL: ${link}`,
          `Access: ${says}.`,
          `Readers see the approved version${version != null ? ` (v${version})` : ""}; later approved versions appear at the same link, drafts never do.`,
          row.expires_at ? `The link stops working at ${row.expires_at}.` : "",
          `To take it down: context_public_link_revoke with link_id ${row.id}.`,
        ]
          .filter(Boolean)
          .join("\n"),
        data: { publish: toPublishResponse(row), link, access },
      };
    }

    if (toolName === "context_public_link_revoke") {
      const id = typeof args.link_id === "string" ? args.link_id.trim() : "";
      const row = id ? await getPublishById(ctx.nestId, id) : undefined;
      if (!row || !(await revokePublish(ctx.nestId, id))) {
        return refusal(PUBLISH_NOT_FOUND, "DOCUMENT_NOT_FOUND");
      }
      const link = `${baseUrl}/p/${row.slug}`;
      return {
        text: `Revoked. ${link} no longer works for anyone. ${row.node_id} itself is unchanged.`,
        data: { revoked: true, id: row.id, node_id: row.node_id, link },
      };
    }
    return `Unknown tool: ${toolName}`;
  } catch (err) {
    if (err instanceof ValidationError) return refusal(err.message, "VALIDATION_FAILED");
    if (err instanceof ForbiddenError) return refusal(err.message, "UNAUTHORIZED_ACTION");
    if (err instanceof NotFoundError) return refusal(err.message, "DOCUMENT_NOT_FOUND");
    if (err instanceof AppError) return refusal(err.message, "VALIDATION_FAILED");
    throw err;
  }
}
