/**
 * First-run onboarding tables (PO-1185), shared by the SQLite migration 084
 * and its Postgres parity block.
 *
 * user_onboarding — one row per person who has seen the welcome screen:
 *   dismissed_at  set by Skip / Done; the screen stays closed while it is set.
 *   reopened      1 after "Getting started" on Home; shows the screen even
 *                 when the person already owns nests.
 *   nest_id       the nest "Create my nest" made, so the screen keeps walking
 *                 the person through connect and fill after it exists.
 *
 * distill_jobs — one row per server-side distill run, polled for progress.
 */
export function onboardingDdl(now: string): string {
  return `
    CREATE TABLE IF NOT EXISTS user_onboarding (
      user_id TEXT PRIMARY KEY,
      nest_id TEXT,
      dismissed_at TEXT,
      reopened INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );

    CREATE TABLE IF NOT EXISTS distill_jobs (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'done', 'failed')),
      phase TEXT NOT NULL DEFAULT 'fetching',
      done_steps INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL DEFAULT 0,
      nodes_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_distill_jobs_user ON distill_jobs(user_id, created_at);
  `;
}
