import { databasePath, openDatabase } from "./database.js";

const db = openDatabase();
try {
  console.log(
    JSON.stringify({
      event: "migrated",
      path: databasePath,
      version: db.pragma("user_version", { simple: true }),
      rooms: db.prepare("SELECT count(*) AS count FROM rooms").get(),
    }),
  );
} finally {
  db.close();
}
