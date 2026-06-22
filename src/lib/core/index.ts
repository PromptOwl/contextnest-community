/**
 * @promptowl/contextnest-community/core
 *
 * Backend-only shared surface for sister apps (e.g. PromptOwl TheOwl). Contains:
 *  - Types: the universally-compatible governance subset
 *  - Pure helpers: role predicates, slug derivation, lifecycle transitions,
 *    markdown serializer + parser, string-safety utilities
 *
 * Intentionally NOT in this surface (yet):
 *  - Adapter interfaces — each repo keeps its own contract until a future
 *    alignment ADR converges them (community has src/governance/adapters.ts,
 *    TheOwl has lib/context-nest/adapters.ts; shapes differ)
 *  - StewardshipScope / DocumentLifecycleStatus / Steward — drift items
 *    requiring a schema migration on at least one side to align
 *  - UI components — out of scope per user decision
 *
 * Consumed internally by contextnest-community via relative paths
 * (../lib/core/*.js) and externally by sister apps via the published
 * subpath (@promptowl/contextnest-community/core).
 */

export * from "./types.js";
export * from "./roles.js";
export * from "./slug.js";
export * from "./lifecycle.js";
export * from "./string-utils.js";
export * from "./markdown.js";
export * from "./markdown-parser.js";
export * from "./consumer-key.js";
export * from "./marketplace-pricing.js";
export * from "./governance/index.js";
