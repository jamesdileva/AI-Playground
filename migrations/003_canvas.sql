CREATE TABLE IF NOT EXISTS canvas_ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  op_type TEXT NOT NULL,
  op_json TEXT NOT NULL,
  bounds TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_ops_seq ON canvas_ops(seq);
