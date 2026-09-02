/**
 * UI constants — must match src/shared/constants.ts on the server.
 * Kept separate because the UI bundle (Vite) doesn't reach across to
 * the server tree. Update both files together if a value ever changes.
 */
export const ANON_USER_ID = "00000000-0000-0000-0000-000000000000";
export const ANON_EMAIL = "admin@localhost";

/**
 * How deep a folder path may nest. The server enforces this on create and
 * move; every UI surface that offers a folder path (New Folder, the document
 * mover, the board's folder columns) checks it first so the user gets the
 * reason inline instead of a swallowed 400.
 */
export const MAX_FOLDER_DEPTH = 8;

/** Documents one bulk approve/reject may carry. Mirrors the server's cap
 *  (BULK_REVIEW_LIMIT in governance/routes.ts) so an oversized selection is
 *  refused where it is made, not as a blanket 400 after the fact. */
export const BULK_REVIEW_LIMIT = 50;
