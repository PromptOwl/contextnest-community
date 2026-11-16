/**
 * Surfaces S2a tables (PRD §5.3): install secrets, OAuth state, event dedup,
 * the encrypted buffer, windows and their verdicts, the explicit-ask fetch
 * queue, proposals (S2a creates them; S2b routes and renders them),
 * fingerprints for dedup and the 7-day hold, counters, purge runs and the
 * per-nest spend budget.
 *
 * One DDL string for both drivers (SQLite migration 080, Postgres parity), on
 * the repo's existing type convention: ids and timestamps TEXT (ISO-8601 UTC
 * written by app code), booleans INTEGER 0/1, JSON TEXT, money INTEGER micros
 * (BIGINT on Postgres). The buffer's ciphertext and nonce are base64 TEXT
 * rather than BLOB/BYTEA so both drivers read them back identically.
 */
export function surfacesS2aDdl(now: string, bigint = "INTEGER"): string {
  return `
    -- Install credentials (bot token, client id/secret, signing secret).
    -- Encrypted with the server secret box; never returned by any route.
    CREATE TABLE IF NOT EXISTS surface_secrets (
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      updated_by TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (install_id, name)
    );

    CREATE TABLE IF NOT EXISTS surface_oauth_states (
      state_hash TEXT PRIMARY KEY,
      install_id TEXT NOT NULL REFERENCES surface_installs(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      nest_id TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${now}
    );

    CREATE TABLE IF NOT EXISTS surface_events_seen (
      install_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (install_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_surface_events_seen_at ON surface_events_seen(received_at);

    CREATE TABLE IF NOT EXISTS surface_windows (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      nest_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      forced INTEGER NOT NULL DEFAULT 0,
      forced_by_surface_user_id TEXT,
      forced_target_id TEXT,
      opened_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      closed_at TEXT,
      close_reason TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      meaningful_chars INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'awaiting_fetch', 'closing', 'judging', 'judged', 'discarded')),
      claim_token TEXT,
      verdict TEXT,
      reason_code TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      kinds TEXT NOT NULL DEFAULT '[]',
      blocked TEXT NOT NULL DEFAULT '{}',
      model TEXT,
      prompt_version TEXT,
      cost_micros ${bigint} NOT NULL DEFAULT 0,
      judged_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_surface_windows_status ON surface_windows(status, last_message_at);
    CREATE INDEX IF NOT EXISTS idx_surface_windows_binding ON surface_windows(binding_id, thread_key, status);
    -- At most one OPEN organic window per (binding, thread key): the atomic
    -- guard when two messages race to open one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_windows_open
      ON surface_windows(binding_id, thread_key) WHERE status = 'open' AND forced = 0;

    -- Gate-surviving message text, AES-256-GCM under SURFACES_BUFFER_KEY.
    -- A forced window holds its own copies, so the key is (window, message).
    CREATE TABLE IF NOT EXISTS surface_buffer (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      install_id TEXT NOT NULL,
      surface_message_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      author_surface_user_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      text_enc TEXT NOT NULL,
      nonce TEXT NOT NULL,
      char_count INTEGER NOT NULL DEFAULT 0,
      meaningful_chars INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (window_id, surface_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_surface_buffer_expires ON surface_buffer(expires_at);
    CREATE INDEX IF NOT EXISTS idx_surface_buffer_window ON surface_buffer(window_id);
    CREATE INDEX IF NOT EXISTS idx_surface_buffer_message ON surface_buffer(binding_id, surface_message_id);
    CREATE INDEX IF NOT EXISTS idx_surface_buffer_author ON surface_buffer(install_id, author_surface_user_id);

    CREATE TABLE IF NOT EXISTS surface_fetch_queue (
      id TEXT PRIMARY KEY,
      install_id TEXT NOT NULL,
      method TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      window_id TEXT,
      requested_by TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'done', 'failed')),
      not_before TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_surface_fetch_queue ON surface_fetch_queue(install_id, method, status, not_before);

    CREATE TABLE IF NOT EXISTS surface_proposals (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      nest_id TEXT NOT NULL,
      card_kind TEXT NOT NULL CHECK(card_kind IN ('single', 'merged', 'conflict', 'agent')),
      state TEXT NOT NULL CHECK(state IN ('queued', 'held', 'posted', 'decided', 'expired', 'withdrawn')),
      named_reviewer_user_id TEXT,
      forced INTEGER NOT NULL DEFAULT 0,
      card_ref TEXT,
      -- The proposer of record (the listener persona), kept so a withdrawal
      -- never depends on the listener still existing (round 2, M2).
      persona_email TEXT,
      -- Card text decided at judge time, while the window text still exists
      -- (round 2, H1): null = use the fixed template.
      card_title TEXT,
      card_summary TEXT,
      -- One "withdrawal failed" alert per proposal, not one per sweep (round 3, N5).
      withdraw_alerted INTEGER NOT NULL DEFAULT 0,
      queued_release_at TEXT,
      posted_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      UNIQUE (window_id)
    );
    CREATE INDEX IF NOT EXISTS idx_surface_proposals_state ON surface_proposals(state, expires_at);
    CREATE INDEX IF NOT EXISTS idx_surface_proposals_binding ON surface_proposals(binding_id, state);

    CREATE TABLE IF NOT EXISTS surface_proposal_items (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES surface_proposals(id) ON DELETE CASCADE,
      nest_id TEXT NOT NULL,
      review_id TEXT,
      node_id TEXT,
      item_kind TEXT NOT NULL,
      op TEXT NOT NULL,
      target_folder TEXT NOT NULL,
      target_node_id TEXT,
      title TEXT,
      title_tokens TEXT NOT NULL DEFAULT '[]',
      confidence REAL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('creating', 'pending', 'approved', 'rejected', 'expired', 'withdrawn', 'dropped')),
      decided_by_user_id TEXT,
      decided_at TEXT,
      version INTEGER,
      reason TEXT,
      previously_held_on TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      UNIQUE (review_id)
    );
    CREATE INDEX IF NOT EXISTS idx_surface_items_nest ON surface_proposal_items(nest_id, state);

    CREATE TABLE IF NOT EXISTS surface_fingerprints (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL,
      binding_id TEXT,
      kind TEXT NOT NULL,
      op TEXT NOT NULL DEFAULT 'new',
      target_folder TEXT NOT NULL,
      target_node_id TEXT,
      node_id TEXT,
      title_tokens TEXT NOT NULL,
      title_hash TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('rejected', 'expired', 'never')),
      hold_until TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_surface_fingerprints ON surface_fingerprints(nest_id, kind, hold_until);

    -- Counters: drop reasons, buffered, verdicts. Never text. binding_id is
    -- 'install:<id>' for messages that matched no binding.
    CREATE TABLE IF NOT EXISTS surface_counters (
      org_id TEXT NOT NULL,
      nest_id TEXT,
      binding_id TEXT NOT NULL,
      day TEXT NOT NULL,
      metric TEXT NOT NULL,
      value ${bigint} NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (binding_id, day, metric)
    );

    CREATE TABLE IF NOT EXISTS surface_purge_runs (
      id TEXT PRIMARY KEY,
      -- ttl | judged | pause | optout | delete | edit | uninstall (counts only)
      purge_trigger TEXT NOT NULL DEFAULT 'ttl',
      binding_id TEXT,
      install_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      rows_deleted INTEGER NOT NULL DEFAULT 0,
      windows_expired INTEGER NOT NULL DEFAULT 0,
      oldest_buffered_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_surface_purge_runs ON surface_purge_runs(started_at);

    CREATE TABLE IF NOT EXISTS surface_nest_budgets (
      nest_id TEXT NOT NULL,
      month TEXT NOT NULL,
      cap_micros ${bigint} NOT NULL,
      spent_micros ${bigint} NOT NULL DEFAULT 0,
      reserved_micros ${bigint} NOT NULL DEFAULT 0,
      alerted_90 INTEGER NOT NULL DEFAULT 0,
      alerted_100 INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (nest_id, month)
    );

    -- Explicit asks per requester per day (§4.1: 10).
    CREATE TABLE IF NOT EXISTS surface_ask_counts (
      install_id TEXT NOT NULL,
      surface_user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (install_id, surface_user_id, day)
    );
  `;
}
