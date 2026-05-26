/**
 * Shared constants — single source of truth for cross-module literals.
 *
 * The anonymous/admin user is the implicit owner of every nest created
 * in open-mode. Hard-coded UUID so the row survives database wipes and
 * stays stable across deployments — never regenerate.
 */
export const ANON_USER_ID = "00000000-0000-0000-0000-000000000000";
export const ANON_EMAIL = "admin@localhost";
