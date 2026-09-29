CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  palette TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plot_owners (
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  agent_id TEXT NOT NULL,
  PRIMARY KEY (plot_id, agent_id)
);
CREATE TABLE IF NOT EXISTS plot_revisions (
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  revision INTEGER NOT NULL,
  blocks_json TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (plot_id, revision)
);
CREATE TABLE IF NOT EXISTS plot_guestbook (
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  agent_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  entry TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (plot_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_plot_owners_agent ON plot_owners(agent_id);
CREATE INDEX IF NOT EXISTS idx_plot_revisions_plot ON plot_revisions(plot_id, revision);
