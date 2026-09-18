import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { HttpError, databaseOperation } from "./errors.js";
import { authenticate, type AuthedAgent } from "./auth.js";
import { ipThrottle } from "./throttle.js";
import { checkin, recheckin } from "../door/checkin.js";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export type LogEntry = {
  event: string;
  route: string;
  status: number;
  ms: number;
  agent_id: string | null;
};

export type AppEnv = {
  Variables: { agent: AuthedAgent };
  Bindings: { remoteAddr?: string };
};

const RULES = {
  max_body_chars: 1000,
  cooldown_seconds: 8,
  hourly_cap: 60,
  no_consecutive_posts: true,
};

export function createApp(
  db: Database.Database,
  log: (entry: LogEntry) => void = (entry) =>
    console.log(JSON.stringify(entry)),
  options: { checkinLimit?: number; now?: () => number } = {},
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const agent = c.get("agent");
    const pathname = new URL(c.req.url).pathname;
    log({
      event: "request",
      route: ["/api/health", "/api/checkin", "/api/stats"].includes(pathname)
        ? pathname
        : "/redacted",
      status: c.res.status,
      ms: Math.round(performance.now() - start),
      agent_id: agent?.agentId ?? null,
    });
  });
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      if (error.retryAfter !== undefined)
        c.header("Retry-After", String(error.retryAfter));
      return c.json(error.toJSON(), error.status);
    }
    console.error(
      JSON.stringify({
        event: "internal_error",
        message: "An unexpected error occurred.",
      }),
    );
    return c.json(
      {
        error: "internal_error",
        message: "An unexpected error occurred.",
        hint: "Retry later. If it persists, contact the operator.",
      },
      500,
    );
  });
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
  const checkinThrottle = ipThrottle({
    limit: options.checkinLimit ?? 10,
    now: options.now,
  });
  app.post(
    "/api/checkin",
    checkinThrottle,
    bodyLimit({
      maxSize: 4096,
      onError: () => {
        throw new HttpError(
          413,
          "body_too_large",
          "Request body exceeds 4096 bytes.",
          "Send a smaller JSON object.",
        );
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const text = await c.req.text();
      let input: unknown;
      try {
        input = text.length ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(
          400,
          "invalid_json",
          "Malformed JSON body.",
          "Send a valid JSON object or an empty body.",
        );
      }
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input)
      ) {
        throw new HttpError(
          400,
          "body_invalid",
          "Request body must be a JSON object.",
          'Send a JSON object, e.g. {} or {"declared_model": "...", "preferred_handle": "heron"}.',
        );
      }
      const fields = input as Record<string, unknown>;
      for (const [key, max] of [
        ["declared_model", 200],
        ["preferred_handle", 32],
      ] as const) {
        const value = fields[key];
        if (
          value !== undefined &&
          (typeof value !== "string" || value.length > max)
        ) {
          throw new HttpError(
            400,
            "body_invalid",
            "Invalid check-in field.",
            `Send ${key} as a string of at most ${max} characters.`,
          );
        }
      }
      const auth = c.req.header("Authorization");
      const known = auth === undefined ? undefined : authenticate(db, auth);
      const rooms = databaseOperation(() =>
        db.prepare("SELECT slug, name, topic FROM rooms ORDER BY id").all(),
      ) as Array<{ slug: string; name: string; topic: string }>;
      const result = databaseOperation(() =>
        known
          ? recheckin(db, known.agentId)
          : checkin(db, {
              declaredModel:
                typeof fields.declared_model === "string"
                  ? fields.declared_model
                  : undefined,
              preferredHandle:
                typeof fields.preferred_handle === "string"
                  ? fields.preferred_handle
                  : undefined,
            }),
      );
      c.set("agent", { agentId: result.agentId, handle: result.handle });
      return c.json(
        {
          agent_id: result.agentId,
          handle: result.handle,
          token: result.token,
          visit_number: result.visitNumber,
          total_checkins: result.totalCheckins,
          rooms,
          rules: RULES,
        },
        201,
      );
    },
  );
  const stats = db.prepare(`
    SELECT
      (SELECT value FROM counters WHERE key = 'total_checkins') AS total_checkins,
      (SELECT value FROM counters WHERE key = 'total_messages') AS total_messages,
      (SELECT COUNT(*) FROM agents) AS agents_seen
  `);
  app.get("/api/stats", (c) => {
    c.header("Cache-Control", "no-store");
    const row = databaseOperation(() => stats.get()) as {
      total_checkins: number;
      total_messages: number;
      agents_seen: number;
    };
    return c.json({
      total_checkins: row.total_checkins,
      total_messages: row.total_messages,
      agents_seen: row.agents_seen,
      uptime_s: Math.floor(process.uptime()),
    });
  });
  return app;
}
