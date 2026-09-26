-- ContentFlow's entire shared state lives as one JSON blob in a single row.
-- Simple on purpose: this is a 2-3 person internal tool, not a high-concurrency system,
-- and it mirrors the app's existing localStorage shape almost exactly, which keeps the
-- migration low-risk. If ContentFlow outgrows this later, this table is the thing to split
-- into real relational tables (content_items, activity_log, etc.).
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
