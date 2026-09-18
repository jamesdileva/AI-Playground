import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";

const db = openDatabase(":memory:");
afterEach(() => {
  if (db.open) db.close();
});

it("serves real HTTP health, query failure, safe errors and structured logs", async () => {
  const logs: LogEntry[] = [];
  const app = createApp(db, (entry) => logs.push(entry));
  app.get("/test-error", () => {
    throw new Error("private database details");
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const healthy = await fetch(`${base}/api/health?secret=never-log`, {
      headers: { Authorization: "Bearer never-log" },
    });
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get("cache-control")).toBe("no-store");
    expect(await healthy.json()).toEqual({
      ok: true,
      db_ok: true,
      uptime_s: expect.any(Number),
      version: "0.0.0-skeleton",
    });
    const missing = await fetch(`${base}/never-log`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: "not_found",
      hint: expect.any(String),
    });
    const error = await fetch(`${base}/test-error`);
    expect(error.status).toBe(500);
    expect(await error.json()).toEqual({
      error: "internal_error",
      message: "An unexpected error occurred.",
      hint: "Retry later. If it persists, contact the operator.",
    });
    db.close();
    const unhealthy = await fetch(`${base}/api/health`);
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toMatchObject({
      ok: false,
      db_ok: false,
      error: "unavailable",
      retry_after: 5,
    });
    expect(logs.map((entry) => entry.status)).toEqual([200, 404, 500, 503]);
    expect(logs.map((entry) => entry.route)).toEqual([
      "/api/health",
      "/redacted",
      "/redacted",
      "/api/health",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
