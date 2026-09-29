CREATE TABLE IF NOT EXISTS phase_state (
  state_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
