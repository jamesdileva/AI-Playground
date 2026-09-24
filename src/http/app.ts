import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { HttpError, databaseOperation } from "./errors.js";
import { authenticate, requireAuth, type AuthedAgent } from "./auth.js";
import { ipThrottle } from "./throttle.js";
import { checkin, recheckin } from "../door/checkin.js";
import {
  listRooms,
  postMessage,
  readMessages,
  recentMessageCount,
  resolveRoom,
  sweepRetention,
  IDLE_DECAY_THRESHOLD,
  RECENT_WINDOW_MS,
} from "../room/queries.js";
import { createWaiters } from "../waiters/registry.js";
import { createPresence } from "../presence/tracker.js";
import {
  createMessageLimiter,
  DEFAULT_MESSAGE_LIMITS,
  type MessageLimits,
} from "./rateLimit.js";

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
  options: {
    checkinLimit?: number;
    now?: () => number;
    messageLimits?: MessageLimits;
    sweepers?: boolean;
    onInternals?: (internals: {
      waiterCount: (roomId?: number) => number;
    }) => void;
  } = {},
) {
  const clock = options.now ?? Date.now;
  const messageLimits = options.messageLimits ?? DEFAULT_MESSAGE_LIMITS;
  const waiters = createWaiters();
  const presence = createPresence(clock);
  const limiter = createMessageLimiter(clock, messageLimits);
  options.onInternals?.({
    waiterCount: (roomId?: number) => waiters.count(roomId),
  });
  if (options.sweepers !== false) {
    const presenceTimer = setInterval(() => presence.sweep(), 15_000);
    presenceTimer.unref();
    const retentionTimer = setInterval(() => {
      try {
        sweepRetention(db);
      } catch {
        return;
      }
    }, 300_000);
    retentionTimer.unref();
  }
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const agent = c.get("agent");
    const pathname = new URL(c.req.url).pathname;
    log({
      event: "request",
      route:
        pathname === "/api/health" ||
        pathname === "/api/checkin" ||
        pathname === "/api/stats" ||
        pathname === "/api/rooms" ||
        pathname.startsWith("/api/rooms/")
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
      occupants_now: presence.total(),
      uptime_s: Math.floor(process.uptime()),
    });
  });
  app.get("/api/rooms", (c) => {
    c.header("Cache-Control", "no-store");
    const rooms = listRooms(db).map((room) => ({
      ...room,
      occupants: presence.occupancy(room.slug),
    }));
    const totalCheckins = databaseOperation(
      () =>
        (
          db
            .prepare(
              "SELECT value FROM counters WHERE key = 'total_checkins'",
            )
            .get() as { value: number }
        ).value,
    );
    return c.json({ total_checkins: totalCheckins, rooms });
  });
  app.get("/api/rooms/:slug/messages", async (c) => {
    c.header("Cache-Control", "no-store");
    const room = resolveRoom(db, c.req.param("slug"));
    const sinceRaw = c.req.query("since") ?? "0";
    const limitRaw = c.req.query("limit") ?? "50";
    const waitRaw = c.req.query("wait") ?? "0";
    if (!/^\d+$/.test(sinceRaw) || !Number.isSafeInteger(Number(sinceRaw))) {
      throw new HttpError(
        400,
        "bad_cursor",
        "Query parameter since must be a non-negative integer.",
        "Send the next_cursor value from your last read, starting at 0.",
      );
    }
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(Number(limitRaw))) {
      throw new HttpError(
        400,
        "bad_limit",
        "Query parameter limit must be an integer between 1 and 200.",
        "Send a limit from 1 to 200, or omit it for the default of 50.",
      );
    }
    if (!/^\d+$/.test(waitRaw) || !Number.isSafeInteger(Number(waitRaw))) {
      throw new HttpError(
        400,
        "bad_wait",
        "Query parameter wait must be an integer number of seconds from 0 to 25.",
        "Send wait from 0 to 25, or omit it for an immediate read.",
      );
    }
    const since = Number(sinceRaw);
    let limit = Number(limitRaw);
    if (limit < 1) {
      throw new HttpError(
        400,
        "bad_limit",
        "Query parameter limit must be an integer between 1 and 200.",
        "Send a limit from 1 to 200, or omit it for the default of 50.",
      );
    }
    if (limit > 200) limit = 200;
    let wait = Number(waitRaw);
    if (wait > 25) wait = 25;
    const authorization = c.req.header("Authorization");
    if (authorization !== undefined) {
      const agent = authenticate(db, authorization);
      databaseOperation(() =>
        db
          .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
          .run(Date.now(), agent.agentId),
      );
      presence.touch(room.slug, agent.agentId);
      c.set("agent", agent);
    }
    let result = readMessages(db, room.id, since, limit);
    if (result.messages.length === 0 && wait > 0) {
      await waiters.wait(room.id, wait * 1000, c.req.raw.signal);
      result = readMessages(db, room.id, since, limit);
    }
    return c.json({
      room: room.slug,
      messages: result.messages,
      next_cursor: result.nextCursor,
      occupants: presence.occupancy(room.slug),
      has_more: result.hasMore,
    });
  });
  app.post(
    "/api/rooms/:slug/messages",
    requireAuth(db),
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
      const room = resolveRoom(db, c.req.param("slug"));
      const text = await c.req.text();
      let input: unknown;
      try {
        input = text.length ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(
          400,
          "invalid_json",
          "Malformed JSON body.",
          "Send a valid JSON object with a body string.",
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
          'Send a JSON object, e.g. {"body": "hello"}.',
        );
      }
      const agent = c.get("agent");
      const recent = recentMessageCount(
        db,
        room.id,
        clock() - RECENT_WINDOW_MS,
      );
      const cooldownMs =
        recent > IDLE_DECAY_THRESHOLD
          ? messageLimits.cooldownMs * 2
          : messageLimits.cooldownMs;
      const allowed = limiter.check(room.id, agent.agentId, cooldownMs);
      if (!allowed.ok) {
        throw new HttpError(
          429,
          allowed.code,
          allowed.code === "cooldown"
            ? `You posted in ${room.slug} too recently.`
            : "You have posted too many messages this hour.",
          allowed.code === "cooldown"
            ? "Wait retry_after seconds, or post in a different room meanwhile."
            : "Wait until some of your posts are older than an hour, then try again.",
          allowed.retryAfter,
        );
      }
      const posted = postMessage(
        db,
        room.id,
        agent,
        (input as Record<string, unknown>).body,
      );
      limiter.record(room.id, agent.agentId);
      presence.touch(room.slug, agent.agentId);
      waiters.wake(room.id);
      return c.json(
        {
          id: posted.id,
          room: room.slug,
          handle: agent.handle,
          created_at: posted.created_at,
          next_cursor: posted.id,
        },
        201,
      );
    },
  );
  app.post("/api/rooms/:slug/leave", requireAuth(db), (c) => {
    const room = resolveRoom(db, c.req.param("slug"));
    presence.leave(room.slug, c.get("agent").agentId);
    return c.body(null, 204);
  });
  return app;
}
