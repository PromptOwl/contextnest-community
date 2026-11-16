/**
 * Surfaces S2b tables and columns (PRD §5.3; §12 R2): interaction
 * idempotency (`surface_actions`), the commit audit (`surface_commits`),
 * per-reviewer and per-conversation daily card usage, personal (DM) nests,
 * the per-person DM opt-out and the "DM capture is off" notice throttle.
 *
 * New columns on S2a tables carry what a card needs after the buffer is
 * purged: the item's summary, the "why" line and the conflict's on-record
 * claim (all purged with the title), and the proposal's window guard
 * (keyed hashes of the window's word shingles, used to re-run the verbatim
 * and leak filters on an edited summary — never text).
 *
 * One DDL string for both drivers (SQLite migration 081, Postgres parity).
 */
export function surfacesS2bDdl(now: string): string {
  return `
    CREATE TABLE IF NOT EXISTS surface_actions (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      proposal_item_id TEXT,
      action TEXT NOT NULL,
      surface TEXT,
      surface_user_id TEXT,
      community_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'done', 'failed')),
      result TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );

    -- Survives uninstall and disconnect (§4.18: life of the nest).
    CREATE TABLE IF NOT EXISTS surface_commits (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      version INTEGER,
      review_id TEXT,
      proposal_item_id TEXT,
      proposal_id TEXT,
      window_id TEXT,
      approved_by_user_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      install_id TEXT,
      surface_user_id TEXT,
      conversation_id TEXT,
      action TEXT NOT NULL DEFAULT 'approve',
      edited INTEGER NOT NULL DEFAULT 0,
      self_vouched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_surface_commits_nest ON surface_commits(nest_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_surface_commits_node ON surface_commits(node_id);

    CREATE TABLE IF NOT EXISTS surface_reviewer_usage (
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      day TEXT NOT NULL,
      cards_posted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (user_id, day)
    );

    CREATE TABLE IF NOT EXISTS surface_conversation_usage (
      binding_id TEXT NOT NULL,
      day TEXT NOT NULL,
      cards_posted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (binding_id, day)
    );

    -- A personal (DM) nest Surfaces created. sealed = 1 (Misha, 2026-11-01):
    -- server admins get no content access, only existence/size/delete.
    CREATE TABLE IF NOT EXISTS surface_personal_nests (
      install_id TEXT NOT NULL,
      community_user_id TEXT NOT NULL,
      nest_id TEXT NOT NULL,
      sealed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (install_id, community_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_surface_personal_nests_nest ON surface_personal_nests(nest_id);

    -- Re-review R3-M1: a password-reset link mailed to a sealed-nest owner
    -- instead of an admin setting their password. sha256 of the token only.
    CREATE TABLE IF NOT EXISTS surface_owner_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${now}
    );

    -- Refused content access by a server admin to a sealed nest: counts only.
    CREATE TABLE IF NOT EXISTS surface_sealed_access_log (
      nest_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      refused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (nest_id, user_id, day)
    );

    -- Rounds 8-9: what a sealed-nest owner has signed in from or with (keys
    -- are hashes: device = sha256 of the User-Agent, client = sha256 of the
    -- agent identity), so alerts fire on what is new, not on every sign-in.
    CREATE TABLE IF NOT EXISTS surface_signin_seen (
      user_id TEXT NOT NULL,
      seen_key TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_alert_at TEXT,
      PRIMARY KEY (user_id, seen_key)
    );

    -- Round 9: owner alerts that must be delivered (configuration changes,
    -- alerts switched off). Retried with backoff until a channel takes them.
    CREATE TABLE IF NOT EXISTS surface_alert_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      text TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      failed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_surface_alert_outbox_due ON surface_alert_outbox(delivered_at, next_at);

    CREATE TABLE IF NOT EXISTS surface_dm_optouts (
      install_id TEXT NOT NULL,
      surface_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (install_id, surface_user_id)
    );

    CREATE TABLE IF NOT EXISTS surface_dm_notices (
      install_id TEXT NOT NULL,
      surface_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (install_id, surface_user_id, kind)
    );
  `;
}

/** Column additions. SQLite runs these once (inside migration 081). */
export const SURFACES_S2B_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["surface_proposal_items", "summary", "TEXT"],
  ["surface_proposal_items", "why", "TEXT"],
  ["surface_proposal_items", "on_record", "TEXT"],
  ["surface_proposal_items", "edited", "INTEGER NOT NULL DEFAULT 0"],
  ["surface_proposals", "queue_reason", "TEXT"],
  ["surface_proposals", "hold_reason", "TEXT"],
  ["surface_proposals", "confidence", "REAL"],
  ["surface_proposals", "outcome_rendered", "TEXT"],
  // §4.17: a card that must be re-rendered to the redacted variant; set until the update succeeds.
  ["surface_proposals", "redaction_pending", "INTEGER NOT NULL DEFAULT 0"],
  // Security round M1: the one retrying card-update path (backoff, then
  // chat.delete, then redaction_failed + one admin alert).
  ["surface_proposals", "redaction_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["surface_proposals", "redaction_next_at", "TEXT"],
  ["surface_proposals", "redaction_failed", "INTEGER NOT NULL DEFAULT 0"],
  // Security round M2: why a binding is paused when it isn't the guard's own
  // verdict (dm_off | dm_optout), so turning DM capture back on resumes it.
  ["surface_bindings", "pause_reason", "TEXT"],
  // Round 4 (Misha, 2026-11-01): a member's "/nest invite" waiting for the
  // booter's consent.
  ["surface_bindings", "invited_by_surface_user_id", "TEXT"],
  ["surface_bindings", "invited_at", "TEXT"],
  ["surface_proposals", "window_guard", "TEXT"],
  ["surface_proposals", "message_count", "INTEGER NOT NULL DEFAULT 0"],
  ["surface_proposals", "first_ts", "TEXT"],
  ["surface_proposals", "last_ts", "TEXT"],
  ["surface_proposals", "requested_by_surface_user_id", "TEXT"],
  ["surface_bindings", "notice_posted_at", "TEXT"],
  ["surface_bindings", "dm_intro_card_at", "TEXT"],
  ["surface_settings", "dm_capture", "INTEGER NOT NULL DEFAULT 0"],
  // Round 8 (Misha, 2026-11-01): sign-in alerts for sealed-nest owners, default ON.
  ["surface_settings", "signin_alerts", "INTEGER NOT NULL DEFAULT 1"],
];

export function surfacesS2bAlterSqlite(): string {
  return SURFACES_S2B_COLUMNS.map(([t, c, ty]) => `ALTER TABLE ${t} ADD COLUMN ${c} ${ty};`).join("\n");
}

export function surfacesS2bAlterPostgres(): string {
  return [
    ...SURFACES_S2B_COLUMNS.map(([t, c, ty]) => `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${ty};`),
    // Re-review R3-L2: an earlier 081 created this table without `sealed`.
    "ALTER TABLE surface_personal_nests ADD COLUMN IF NOT EXISTS sealed INTEGER NOT NULL DEFAULT 1;",
  ].join("\n");
}
