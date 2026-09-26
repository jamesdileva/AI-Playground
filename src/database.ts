import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const databasePath =
  process.env.DB_PATH ??
  fileURLToPath(new URL("../hangout.db", import.meta.url));
const migrationsPath = new URL("../migrations/", import.meta.url);
const migrations = ["001_init.sql", "002_seed_rooms.sql"];

export function migrate(db: Database.Database): number {
  return db
    .transaction(() => {
      const version = db.pragma("user_version", { simple: true }) as number;
      if (version > migrations.length) {
        throw new Error("Database schema is newer than this application.");
      }
      for (let index = version; index < migrations.length; index++) {
        const filename = migrations[index]!;
        db.exec(readFileSync(new URL(filename, migrationsPath), "utf8"));
        db.pragma(`user_version = ${index + 1}`);
      }
      return migrations.length - version;
    })
    .immediate();
}

export function openDatabase(path = databasePath): Database.Database {
  const db = new Database(path);
  try {
    if ((db.pragma("user_version", { simple: true }) as number) > migrations.length) {
      throw new Error("Database schema is newer than this application.");
    }
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
