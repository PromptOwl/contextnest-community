/**
 * Re-export shim. Source of truth lives in src/lib/core/roles.ts so the
 * same code is shipped to sister apps via
 * `@promptowl/contextnest-community/core` without duplicating definitions.
 *
 * Existing imports like `from "./roles.js"` keep working unchanged.
 */

export * from "../lib/core/roles.js";
