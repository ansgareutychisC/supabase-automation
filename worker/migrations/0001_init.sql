-- D1 Schema: Supabase Onboarding Fleet Manager
-- Run: npx wrangler d1 execute supabase-onboarding --file=migrations/0001_init.sql

-- Accounts (one per email address)
CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    user_id TEXT,                    -- gotrue user UUID
    profile_id INTEGER,              -- platform numeric ID
    access_token TEXT,               -- short-lived JWT (30 min)
    refresh_token TEXT,              -- for refreshing JWT
    token_expires_at INTEGER,        -- epoch seconds
    pat TEXT,                        -- long-lived sbp_... token
    pat_id INTEGER,
    pat_name TEXT,
    pat_alias TEXT,
    pat_expires_at TEXT,             -- ISO 8601
    org_id INTEGER,
    org_slug TEXT,
    org_name TEXT,
    plan_id TEXT DEFAULT 'free',
    cookies TEXT,                    -- JSON array of saved cookies for replay
    session_data TEXT,               -- JSON: localStorage auth tokens, etc.
    status TEXT DEFAULT 'created',   -- created → signed_up → verified → profiled → org_created → complete
    onboarding_report TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_org_slug ON accounts(org_slug);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

-- Jobs (async pipeline execution)
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    account_email TEXT,
    stage TEXT NOT NULL,             -- signup, verify, profile, org, pat, full
    status TEXT DEFAULT 'pending',   -- pending → running → completed → failed → cancelled
    options TEXT,                    -- JSON blob of job parameters
    result TEXT,                     -- JSON blob of job result
    error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_email);
