CREATE TABLE IF NOT EXISTS selfie_links (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_bot_updates (
  update_id INTEGER PRIMARY KEY,
  response_chat_id TEXT NOT NULL
);
