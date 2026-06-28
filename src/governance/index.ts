/**
 * Governance Layer — barrel export.
 *
 * This module is the subscribable governance layer. PromptOwl can implement
 * the same adapter interfaces with MongoDB instead of SQLite.
 */

// Types and interfaces (the contract)
export * from "./types.js";
export * from "./adapters.js";

// SQLite implementations
export * as stewardship from "./stewardship-service.js";
export * as reviews from "./review-service.js";
export * as comments from "./comment-service.js";
export * as versions from "./version-service.js";
export * as access from "./access-service.js";
export { parseStewardsYaml, loadStewardsConfig, hasStweardshipConfig } from "./stewards-parser.js";
