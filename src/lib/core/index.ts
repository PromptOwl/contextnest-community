/**
 * @promptowl/contextnest-community/core
 *
 * Backend-only shared surface for sister apps (e.g. PromptOwl TheOwl).
 *
 * Source-of-truth chain (per ADR-0001):
 *   engine → community/core → sister apps
 *
 * Contains:
 *  - Types re-exported from `@promptowl/contextnest-engine`: `StewardRole`,
 *    `StewardshipScope`, `DocumentLifecycleStatus`.
 *  - Community-only governance types the engine doesn't model:
 *    `ReviewRequestPriority`, `ReviewRequestStatus`, `StewardEntry`,
 *    `StewardsConfig`, `DocumentVersion`, `VersionConflict`, `UserRef`.
 *  - Pure helpers: role predicates, slug derivation, lifecycle transitions,
 *    markdown serializer + parser, string-safety utilities.
 *
 * Intentionally NOT in this surface:
 *  - Adapter interfaces — each repo keeps its own contract until a future
 *    alignment ADR converges them (community has src/governance/adapters.ts,
 *    TheOwl has lib/context-nest/adapters.ts; shapes differ).
 *  - Concrete `Steward` interface — community's SQLite shape and TheOwl's
 *    Mongoose multi-user shape are both first-class. Engine ships
 *    `SingleUserSteward` (canonical) and `MultiUserSteward` for callers
 *    who want a Mongo-backed store directly.
 *  - UI components — out of scope per user decision.
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
