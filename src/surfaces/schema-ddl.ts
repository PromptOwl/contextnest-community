/**
 * Surfaces S1 tables (PRD §5.3; binding states per §12 R3). One DDL string for
 * both drivers so SQLite (migrations.ts 079) and Postgres
 * (migrations.postgres.ts) cannot drift. Follows the repo's existing type
 * convention on both drivers: ids and timestamps are TEXT (ISO-8601 UTC,
 * written by app code), booleans are INTEGER 0/1, JSON is TEXT.
 *
 * `now` is the driver's default-timestamp expression.
 */
export function surfacesS1Ddl(now: string): string {
  return `
    CREATE TABLE IF NOT EXISTS surface_settings (
      org_id TEXT PRIMARY KEY,
      quiet_minutes INTEGER NOT NULL DEFAULT 20,
      window_max_age_hours INTEGER NOT NULL DEFAULT 6,
      buffer_ttl_hours INTEGER NOT NULL DEFAULT 24,
      min_meaningful_chars INTEGER NOT NULL DEFAULT 6,
      propose_threshold REAL NOT NULL DEFAULT 0.7,
      reviewer_daily_cards INTEGER NOT NULL DEFAULT 2,
      conversation_daily_cards INTEGER NOT NULL DEFAULT 3,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );

    CREATE TABLE IF NOT EXISTS surface_installs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      surface TEXT NOT NULL CHECK(surface IN ('slack', 'teams', 'email')),
      mode TEXT NOT NULL CHECK(mode IN ('manifest', 'hosted', 'selfhosted')),
      tenant_key TEXT NOT NULL,
      team_id TEXT,
      enterprise_id TEXT,
      bot_user_id TEXT,
      home_nest_id TEXT,
      installed_by_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'active', 'revoked', 'disconnected')),
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_installs_live
      ON surface_installs(surface, tenant_key) WHERE status IN ('pending', 'active');

    CREATE TABLE IF NOT EXISTS surface_bindings (
      id TEXT PRIMARY KEY,
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      conversation_kind TEXT NOT NULL CHECK(conversation_kind IN
        ('public_channel', 'private_channel', 'dm', 'teams_standard', 'teams_chat', 'email_address')),
      conversation_name TEXT,
      is_general INTEGER NOT NULL DEFAULT 0,
      dm_owner_user_id TEXT,
      listener_agent_node_id TEXT,
      explicit_public_bind INTEGER NOT NULL DEFAULT 0,
      is_ext_shared INTEGER NOT NULL DEFAULT 0,
      ext_capture_enabled INTEGER NOT NULL DEFAULT 0,
      bound_by_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused_guard', 'paused_by_member', 'removed')),
      status_changed_at TEXT,
      booted_by_surface_user_id TEXT,
      booted_at TEXT,
      boot_consent_at TEXT,
      capture_ok INTEGER NOT NULL DEFAULT 0,
      surface_ok INTEGER NOT NULL DEFAULT 0,
      members_known INTEGER NOT NULL DEFAULT 0,
      guard_detail TEXT NOT NULL DEFAULT '{}',
      guard_checked_at TEXT,
      guard_dirty INTEGER NOT NULL DEFAULT 0,
      -- bumped by every invalidation; a re-check clears guard_dirty only if
      -- the epoch it started from is still current (no lost change).
      guard_dirty_epoch INTEGER NOT NULL DEFAULT 0,
      guard_dirty_at TEXT,
      -- bumped by every write; status transitions are compare-and-set on it.
      version INTEGER NOT NULL DEFAULT 0,
      readers_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      UNIQUE(install_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_surface_bindings_nest ON surface_bindings(nest_id);
    CREATE INDEX IF NOT EXISTS idx_surface_bindings_dirty ON surface_bindings(guard_dirty);

    CREATE TABLE IF NOT EXISTS surface_members_cache (
      binding_id TEXT NOT NULL REFERENCES surface_bindings(id) ON DELETE CASCADE,
      surface_user_id TEXT NOT NULL,
      is_guest INTEGER NOT NULL DEFAULT 0,
      is_external INTEGER NOT NULL DEFAULT 0,
      is_bot INTEGER NOT NULL DEFAULT 0,
      home_tenant TEXT,
      fetched_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (binding_id, surface_user_id)
    );

    CREATE TABLE IF NOT EXISTS surface_users_cache (
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      surface_user_id TEXT NOT NULL,
      home_team_id TEXT,
      enterprise_id TEXT,
      email TEXT,
      email_confirmed INTEGER,
      is_restricted INTEGER NOT NULL DEFAULT 0,
      is_ultra_restricted INTEGER NOT NULL DEFAULT 0,
      is_stranger INTEGER NOT NULL DEFAULT 0,
      is_bot INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      user_role TEXT,
      display_name TEXT,
      fetched_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (install_id, surface_user_id)
    );

    CREATE TABLE IF NOT EXISTS surface_identity_links (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      surface TEXT NOT NULL,
      surface_user_id TEXT NOT NULL,
      community_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method TEXT NOT NULL CHECK(method IN ('explicit', 'auto_email', 'one_time', 'admin_review')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      first_use_confirmed_at TEXT,
      surface_email_at_link TEXT,
      auto_match_blocked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      revoked_by TEXT,
      revoke_reason TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_links_active
      ON surface_identity_links(install_id, surface_user_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_surface_links_user ON surface_identity_links(community_user_id);

    CREATE TABLE IF NOT EXISTS surface_link_tokens (
      token_hash TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK(purpose IN ('link', 'revoke', 'signup')),
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      surface_user_id TEXT NOT NULL,
      community_user_id TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT ${now}
    );

    CREATE TABLE IF NOT EXISTS surface_link_reviews (
      id TEXT PRIMARY KEY,
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      surface_user_id TEXT NOT NULL,
      surface_email TEXT,
      community_user_id TEXT NOT NULL,
      community_email TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_surface_link_reviews ON surface_link_reviews(install_id, status);

    CREATE TABLE IF NOT EXISTS surface_optouts (
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      surface_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (install_id, surface_user_id)
    );

    -- Admin alerts and user notices (counts only, never names or message text).
    CREATE TABLE IF NOT EXISTS surface_notices (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      audience TEXT NOT NULL CHECK(audience IN ('admins', 'user')),
      recipient_user_id TEXT,
      binding_id TEXT,
      nest_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      email_outcome TEXT,
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_surface_notices_kind ON surface_notices(kind, created_at);
  `;
}
