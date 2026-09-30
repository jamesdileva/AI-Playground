CREATE TABLE IF NOT EXISTS gallery_canvases (
  epoch INTEGER PRIMARY KEY,
  seq_start INTEGER NOT NULL,
  seq_end INTEGER NOT NULL,
  snapshot_blob BLOB NOT NULL,
  contributors TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  confirmed_by TEXT,
  finished_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gallery_plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_slug TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  final_revision INTEGER NOT NULL,
  founder TEXT NOT NULL,
  co_owners TEXT NOT NULL,
  retired_at INTEGER NOT NULL
);
ALTER TABLE canvas_ops ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_canvas_ops_epoch_seq ON canvas_ops(epoch, seq);
INSERT INTO counters (key, value) SELECT 'canvas_epoch', 1 WHERE NOT EXISTS (SELECT 1 FROM counters WHERE key = 'canvas_epoch');
