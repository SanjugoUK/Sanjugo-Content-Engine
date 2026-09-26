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

-- Team chat. Append-only so simultaneous messages never clobber each other (unlike the app_state blob).
-- The worker also creates this automatically on first use, so running this file is optional.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  content_id TEXT,
  created_at TEXT NOT NULL
);
