import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/database.js";

const connections: Database.Database[] = [];
const directories: string[] = [];
function open(path = ":memory:") {
  const db = openDatabase(path);
  connections.push(db);
  return db;
}
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("database migrations", () => {
  it("seeds exactly the five contracted rooms and initializes counters", () => {
    const db = open();
    expect(db.prepare("SELECT slug FROM rooms ORDER BY id").all()).toEqual([
      { slug: "kitchen" },
      { slug: "balcony" },
      { slug: "couch" },
      { slug: "dancefloor" },
      { slug: "porch" },
    ]);
    expect(
      db.prepare("SELECT key, value FROM counters ORDER BY key").all(),
    ).toEqual([
      { key: "total_checkins", value: 0 },
      { key: "total_messages", value: 0 },
    ]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("runs twice without any changes and preserves data across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "hangout-"));
    directories.push(directory);
    const path = join(directory, "hangout.db");
    const db = open(path);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.prepare(
      "UPDATE counters SET value = 7 WHERE key = 'total_checkins'",
    ).run();
    const before = db.prepare("SELECT total_changes() AS count").get();
    expect(migrate(db)).toBe(0);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    db.close();
    const reopened = open(path);
    expect(
      reopened.prepare("SELECT count(*) AS count FROM rooms").get(),
    ).toEqual({ count: 5 });
    expect(
      reopened
        .prepare("SELECT value FROM counters WHERE key = 'total_checkins'")
        .get(),
    ).toEqual({ value: 7 });
    expect(reopened.pragma("user_version", { simple: true })).toBe(2);
  });
  it("rolls back schema and version if a later migration fails", () => {
    const db = new Database(":memory:");
    connections.push(db);
    db.exec("CREATE TEMP TABLE rooms (id INTEGER)");
    expect(() => migrate(db)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([]);
    db.exec("DROP TABLE temp.rooms");
    expect(migrate(db)).toBe(2);
  });
  it("does not change journal mode or data when opening a newer database", () => {
    const directory = mkdtempSync(join(tmpdir(), "hangout-"));
    directories.push(directory);
    const path = join(directory, "newer.db");
    const original = new Database(path);
    original.exec("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('preserved')");
    original.pragma("user_version = 99");
    original.close();
    expect(() => openDatabase(path)).toThrow("newer");
    const reopened = new Database(path);
    connections.push(reopened);
    expect(reopened.pragma("journal_mode", { simple: true })).toBe("delete");
    expect(reopened.prepare("SELECT value FROM future_data").get()).toEqual({ value: "preserved" });
  });
  it("rejects a database newer than the application without changing it", () => {
    const db = open();
    db.pragma("user_version = 99");
    expect(() => migrate(db)).toThrow("newer");
    expect(db.pragma("user_version", { simple: true })).toBe(99);
  });
});
