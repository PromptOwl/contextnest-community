/**
 * Shared constants — single source of truth for cross-module literals.
 *
 * The anonymous/admin user is the implicit owner of every nest created
 * in open-mode. Hard-coded UUID so the row survives database wipes and
 * stays stable across deployments — never regenerate.
 */
export const ANON_USER_ID = "00000000-0000-0000-0000-000000000000";
export const ANON_EMAIL = "admin@localhost";

/**
 * How deep a folder path may nest. Enforced on create and move
 * (nodes/service.ts); the UI checks the same bound before the round-trip, so
 * keep this in step with MAX_FOLDER_DEPTH in ui/src/lib/constants.ts.
 */
export const MAX_FOLDER_DEPTH = 8;
