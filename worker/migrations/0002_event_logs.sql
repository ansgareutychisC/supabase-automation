-- Event logs for detailed audit trail of all account operations.
-- Captures signup failures, health check results, token refreshes, etc.
CREATE TABLE IF NOT EXISTS event_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_email TEXT,
    event_type TEXT NOT NULL,        -- signup_started, signup_failed, verify_ok, health_check, token_refreshed, etc.
    severity TEXT NOT NULL DEFAULT 'info',  -- info, warn, error
    message TEXT NOT NULL,
    details TEXT,                    -- JSON blob with full context
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_logs_account ON event_logs(account_email);
CREATE INDEX IF NOT EXISTS idx_event_logs_created ON event_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_logs_severity ON event_logs(severity);
