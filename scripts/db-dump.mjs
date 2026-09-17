import Database from "better-sqlite3";

const db = new Database(process.argv[2] ?? "hangout.db", { readonly: true });
try {
  const rooms = db.prepare("SELECT slug FROM rooms ORDER BY id").all();
  const agents = db.prepare("SELECT count(*) AS count FROM agents").get();
  const messages = db.prepare("SELECT count(*) AS count FROM messages").get();
  const counters = db.prepare("SELECT key, value FROM counters ORDER BY key").all();
  const userVersion = db.pragma("user_version", { simple: true });
  console.log(JSON.stringify({ rooms, agents, messages, counters, user_version: userVersion }));
} finally {
  db.close();
}
