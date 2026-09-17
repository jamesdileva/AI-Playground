import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };
export type LogEntry = {
  event: string;
  route: string;
  status: number;
  ms: number;
  agent_id: null;
};

export function createApp(
  db: Database.Database,
  log: (entry: LogEntry) => void = (entry) =>
    console.log(JSON.stringify(entry)),
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    log({
      event: "request",
      route: c.req.path === "/api/health" ? "/api/health" : "unmatched",
      status: c.res.status,
      ms: Math.round(performance.now() - start),
      agent_id: null,
    });
  });
  app.onError((_error, c) =>
    c.json(
      {
        error: "internal_error",
        message: "An unexpected error occurred.",
        hint: "Retry later. If it persists, contact the operator.",
      },
      500,
    ),
  );
  app.notFound((c) =>
    c.json(
      {
        error: "not_found",
        message: "This endpoint does not exist.",
        hint: "Use GET /api/health to check service availability.",
      },
      404,
    ),
  );
  app.get("/api/health", (c) => {
    let dbOk: boolean;
    try {
      db.prepare("SELECT id FROM rooms LIMIT 1").get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        ok: dbOk,
        db_ok: dbOk,
        uptime_s: Math.floor(process.uptime()),
        version,
        ...(!dbOk
          ? {
              error: "unavailable",
              message: "Database health query failed.",
              hint: "Retry after the operator restores database access.",
              retry_after: 5,
            }
          : {}),
      },
      dbOk ? 200 : 503,
    );
  });
  return app;
}
