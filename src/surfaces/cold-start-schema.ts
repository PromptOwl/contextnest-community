/**
 * Cold start (po-1186 CR2): the shared input schemas. The REST route
 * (`GET /surfaces/cold-start`) validates with `ColdStartQuery`; the per-nest
 * MCP twin (`context_surfaces_cold_start`) is bound to its nest, so its input
 * is `ColdStartMcpInput` (no fields) and its JSON schema is generated from it
 * — no inline schema literal (lint:mcp-schemas).
 */
import { z } from "zod";

export const ColdStartQuery = z.object({
  nest_id: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("One nest you own or administer. Omitted: every seeded nest you administer (every seeded nest for a server admin)."),
});

/** The per-nest MCP tool reads the nest its endpoint is bound to. */
export const ColdStartMcpInput = ColdStartQuery.omit({ nest_id: true });
