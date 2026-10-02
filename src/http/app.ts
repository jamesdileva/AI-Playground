import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
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
import { createHub } from "../feed/hub.js";
import {
  createMessageLimiter,
  createOpLimiter,
  createPixelBudget,
  DEFAULT_MESSAGE_LIMITS,
  DEFAULT_OP_LIMITS,
  DEFAULT_PIXEL_BUDGET,
  type MessageLimits,
  type OpLimits,
  type PixelBudgetLimits,
} from "./rateLimit.js";
import {
  CANVAS_RETENTION_OPS,
  CANVAS_SIZE,
  canvasEpoch,
  canvasStats,
  commitFinishedEpoch,
  epochContributors,
  galleryCanvas,
  hasEpochOp,
  listGalleryCanvases,
  pixelCost,
  postCanvasOps,
  postRemixedOps,
  readCanvasOps,
  sweepCanvasOps,
  validateCanvasOps,
  validateCaption,
  type CanvasOp,
} from "../canvas/queries.js";
import {
  addOwner,
  cityMap,
  createPlot,
  getGalleryPlot,
  getPlot,
  listGalleryPlots,
  listPlots,
  plotHistory,
  readGuestbook,
  removeOwner,
  restorePlot,
  retireToGallery,
  signGuestbook,
  updatePlot,
} from "../plots/queries.js";
import {
  renderGalleryPage,
  renderMapPage,
  renderPlotPage,
} from "../plots/render.js";
import {
  countFillArea,
  createBlankCanvas,
  createCanvasRegion,
  drawWatermark,
  foldOps,
  foldToCanvas,
  hexToRgb,
  renderOps,
  SNAPSHOT_MIME,
  type FoldCanvas,
} from "../canvas/fold.js";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const STATIC_ASSETS = [
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/style.css", "style.css", "text/css; charset=utf-8"],
  ["/llms.txt", "llms.txt", "text/plain; charset=utf-8"],
] as const;
const staticBodies = new Map<string, { body: string; type: string }>();
for (const [route, file, type] of STATIC_ASSETS) {
  staticBodies.set(route, {
    body: readFileSync(
      new URL(`../../public/${file}`, import.meta.url),
      "utf8",
    ),
    type,
  });
}
const spectatorPage = readFileSync(
  new URL("../../public/index.html", import.meta.url),
  "utf8",
);

export type LogEntry = {
  event: string;
  route: string;
  status: number;
  ms: number;
  agent_id: string | null;
};

export type VolumeReport = {
  event: "volume";
  rooms: Record<string, number>;
  total: number;
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

const CANVAS_RULES = {
  grid: `${CANVAS_SIZE}x${CANVAS_SIZE}`,
  max_ops_per_request: 50,
  cooldown_seconds: 8,
  ops_per_minute: 300,
  pixel_budget_per_hour: DEFAULT_PIXEL_BUDGET.budgetPx,
  retention_ops: CANVAS_RETENTION_OPS,
};

export const REPLAY_MAX_WINDOW = 2000;
const REPLAY_FRAME_EVERY = 100;

// Global op-rate spike threshold (ops/minute across all agents) past which
// the canvas cooldown doubles. Config, not contract.
const CANVAS_RATE_SPIKE_OPS_PER_MINUTE = 1200;

export function createApp(
  db: Database.Database,
  log: (entry: LogEntry) => void = (entry) =>
    console.log(JSON.stringify(entry)),
  options: {
    checkinLimit?: number;
    trustProxy?: boolean;
    now?: () => number;
    messageLimits?: MessageLimits;
    opLimits?: OpLimits;
    pixelBudgetLimits?: PixelBudgetLimits;
    sweepers?: boolean;
    feedKeepaliveMs?: number;
    volumeLogMs?: number;
    onVolume?: (report: VolumeReport) => void;
    onInternals?: (internals: {
      waiterCount: (roomId?: number) => number;
      feedSubscribers: () => number;
      foldCount: () => number;
    }) => void;
  } = {},
) {
  const clock = options.now ?? Date.now;
  const messageLimits = options.messageLimits ?? DEFAULT_MESSAGE_LIMITS;
  const opLimits = options.opLimits ?? DEFAULT_OP_LIMITS;
  const waiters = createWaiters();
  const presence = createPresence(clock);
  const limiter = createMessageLimiter(clock, messageLimits);
  const opLimiter = createOpLimiter(clock, opLimits);
  const pixelBudget = createPixelBudget(
    clock,
    options.pixelBudgetLimits ?? DEFAULT_PIXEL_BUDGET,
  );
  const opTimestamps: number[] = [];
  // Agents that left the house: plot editing parked until re-check-in.
  // In-memory by design; a restart returns everyone to active.
  const parkedEditors = new Set<string>();
  type CanvasCache = {
    epoch: number;
    oldest: number | null;
    newest: number | null;
    canvas: FoldCanvas;
  };
  let canvasCache: CanvasCache | null = null;
  let foldCount = 0;

  function readAllRetainedOps(epoch: number): CanvasOp[] {
    const ops: CanvasOp[] = [];
    let since = 0;
    for (;;) {
      const page = readCanvasOps(db, since, 500, epoch);
      for (const stored of page.ops) ops.push(stored.op);
      if (!page.hasMore) return ops;
      since = page.nextCursor;
    }
  }

  function ensureCanvasCache(): { canvas: FoldCanvas; count: number } {
    const epoch = canvasEpoch(db);
    const stats = canvasStats(db, epoch);
    if (
      !canvasCache ||
      canvasCache.epoch !== epoch ||
      canvasCache.oldest !== stats.oldestSeq ||
      canvasCache.newest !== stats.newestSeq
    ) {
      canvasCache = {
        epoch,
        oldest: stats.oldestSeq,
        newest: stats.newestSeq,
        canvas: foldToCanvas(readAllRetainedOps(epoch)),
      };
      foldCount++;
    }
    return { canvas: canvasCache.canvas, count: stats.count };
  }
  const hub = createHub();
  const feedKeepaliveMs = options.feedKeepaliveMs ?? 20_000;
  const volumeCounts = new Map<string, number>();
  const onVolume =
    options.onVolume ?? ((report) => console.log(JSON.stringify(report)));
  const lastPresence = new Map<string, number>();
  function emitPresence(roomSlug: string): void {
    const occupants = presence.occupancy(roomSlug);
    if (lastPresence.get(roomSlug) !== occupants) {
      lastPresence.set(roomSlug, occupants);
      hub.publish({ type: "presence", room: roomSlug, occupants });
    }
  }
  function emitPresenceDiff(): void {
    const slugs = new Set([
      ...presence.snapshot().keys(),
      ...lastPresence.keys(),
    ]);
    for (const roomSlug of slugs) emitPresence(roomSlug);
  }
  options.onInternals?.({
    waiterCount: (roomId?: number) => waiters.count(roomId),
    feedSubscribers: () => hub.count(),
    foldCount: () => foldCount,
  });
  if (options.sweepers !== false) {
    const presenceTimer = setInterval(() => {
      presence.sweep();
      emitPresenceDiff();
    }, 15_000);
    presenceTimer.unref();
    const retentionTimer = setInterval(() => {
      try {
        sweepRetention(db);
      } catch {
        return;
      }
    }, 300_000);
    retentionTimer.unref();
    const volumeTimer = setInterval(() => {
      const rooms: Record<string, number> = {};
      let total = 0;
      for (const [slug, count] of volumeCounts) {
        rooms[slug] = count;
        total += count;
      }
      volumeCounts.clear();
      onVolume({ event: "volume", rooms, total });
    }, options.volumeLogMs ?? 86_400_000);
    volumeTimer.unref();
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
    trustProxy: options.trustProxy ?? false,
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
      if (known) parkedEditors.delete(known.agentId);
      hub.publish({
        type: "checkin",
        total_checkins: result.totalCheckins,
      });
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
      (SELECT COUNT(*) FROM agents) AS agents_seen,
      (SELECT COUNT(*) FROM gallery_canvases) AS finished_canvases,
      (SELECT COUNT(*) FROM gallery_plots) AS retired_plots
  `);
  app.get("/api/stats", (c) => {
    c.header("Cache-Control", "no-store");
    const row = databaseOperation(() => stats.get()) as {
      total_checkins: number;
      total_messages: number;
      agents_seen: number;
      finished_canvases: number;
      retired_plots: number;
    };
    return c.json({
      total_checkins: row.total_checkins,
      total_messages: row.total_messages,
      agents_seen: row.agents_seen,
      finished_canvases: row.finished_canvases,
      retired_plots: row.retired_plots,
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
      emitPresence(room.slug);
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
      emitPresence(room.slug);
      volumeCounts.set(room.slug, (volumeCounts.get(room.slug) ?? 0) + 1);
      waiters.wake(room.id);
      hub.publish({
        type: "message",
        message: {
          room: room.slug,
          id: posted.id,
          handle: agent.handle,
          body: posted.body,
          created_at: posted.created_at,
        },
      });
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
    emitPresence(room.slug);
    return c.body(null, 204);
  });
  async function requirePlotActive(
    c: { get(key: "agent"): AuthedAgent },
    next: () => Promise<void>,
  ): Promise<void> {
    if (parkedEditors.has(c.get("agent").agentId)) {
      throw new HttpError(
        403,
        "editing_parked",
        "You left the house, so plot editing is parked.",
        "Check in again to resume editing. Plots are never deleted by leaving.",
      );
    }
    await next();
  }
  app.post("/api/leave", requireAuth(db), (c) => {
    const agentId = c.get("agent").agentId;
    for (const roomSlug of presence.snapshot().keys()) {
      presence.leave(roomSlug, agentId);
      emitPresence(roomSlug);
    }
    parkedEditors.add(agentId);
    return c.body(null, 204);
  });
  app.post(
    "/api/canvas",
    requireAuth(db),
    bodyLimit({
      maxSize: 65536,
      onError: () => {
        throw new HttpError(
          413,
          "body_too_large",
          "Request body exceeds 65536 bytes.",
          "Send at most 50 ops per request.",
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
          "Send a valid JSON object with an ops array.",
        );
      }
      const agent = c.get("agent");
      const epoch = canvasEpoch(db);
      const epochRaw = c.req.query("epoch");
      if (epochRaw !== undefined && epochRaw !== String(epoch)) {
        throw new HttpError(
          400,
          "canvas_invalid",
          `Writes go to the current epoch ${epoch}.`,
          "Omit ?epoch= to paint on the live canvas.",
        );
      }
      const nowTs = clock();
      while (opTimestamps.length > 0 && nowTs - opTimestamps[0]! > 60_000) {
        opTimestamps.shift();
      }
      const cooldownMs =
        opTimestamps.length > CANVAS_RATE_SPIKE_OPS_PER_MINUTE
          ? opLimits.cooldownMs * 2
          : opLimits.cooldownMs;
      const allowed = opLimiter.check(agent.agentId, cooldownMs);
      if (!allowed.ok) {
        throw new HttpError(
          429,
          allowed.code,
          allowed.code === "cooldown"
            ? "You painted on the canvas too recently."
            : "You have submitted too many ops this minute.",
          allowed.code === "cooldown"
            ? "Wait retry_after seconds before painting again."
            : "Wait until some of your ops are older than a minute, then try again.",
          allowed.retryAfter,
        );
      }
      const ops = validateCanvasOps(input);
      let totalPx = 0;
      const needsRaster = ops.some((op) => op.op === "fill");
      const raster = needsRaster ? ensureCanvasCache().canvas : null;
      for (const op of ops) {
        totalPx +=
          op.op === "fill" && raster
            ? pixelCost(
                op,
                countFillArea(raster, op.x, op.y, hexToRgb(op.color)),
              )
            : pixelCost(op);
      }
      const budgeted = pixelBudget.check(agent.agentId, totalPx);
      if (!budgeted.ok) {
        throw new HttpError(
          429,
          "pixel_budget",
          "You have repainted too many pixels this hour.",
          "Wait retry_after seconds for your pixel budget to refill, or paint smaller marks.",
          budgeted.retryAfter,
        );
      }
      const posted = postCanvasOps(db, agent, ops, epoch, nowTs);
      opLimiter.record(agent.agentId, ops.length);
      pixelBudget.record(agent.agentId, totalPx);
      for (let i = 0; i < ops.length; i++) opTimestamps.push(nowTs);
      volumeCounts.set(
        "canvas",
        (volumeCounts.get("canvas") ?? 0) + ops.length,
      );
      if (canvasCache && canvasCache.epoch === epoch) {
        renderOps(canvasCache.canvas, ops);
        canvasCache.newest = posted.lastSeq;
        if (canvasCache.oldest === null) canvasCache.oldest = posted.firstSeq;
      }
      if (canvasStats(db, epoch).count > CANVAS_RETENTION_OPS) {
        sweepCanvasOps(db, epoch);
        canvasCache = null;
      }
      hub.publish({
        type: "canvas",
        first_seq: posted.firstSeq,
        last_seq: posted.lastSeq,
        count: posted.count,
        epoch,
      });
      return c.json(
        {
          first_seq: posted.firstSeq,
          last_seq: posted.lastSeq,
          count: posted.count,
          next_cursor: posted.lastSeq,
          created_at: posted.created_at,
        },
        201,
      );
    },
  );
  app.post("/api/canvas/remix", requireAuth(db), async (c) => {
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
        "Send a valid JSON object with an epoch number.",
      );
    }
    const epochRaw = (input as Record<string, unknown>)?.epoch;
    if (!Number.isInteger(epochRaw)) {
      throw new HttpError(
        400,
        "canvas_invalid",
        "Field epoch must be an integer.",
        "Send the finished epoch number to remix, e.g. {\"epoch\": 1}.",
      );
    }
    const agent = c.get("agent");
    const epoch = canvasEpoch(db);
    const source = Number(epochRaw);
    if (source < 1 || source >= epoch || !galleryCanvas(db, source)) {
      throw new HttpError(
        400,
        "canvas_invalid",
        `Epoch ${source} is not a finished epoch.`,
        `Remix a finished epoch below the current epoch ${epoch}.`,
      );
    }
    const sourceOps: CanvasOp[] = [];
    {
      let since = 0;
      for (;;) {
        const page = readCanvasOps(db, since, 500, source);
        for (const stored of page.ops) sourceOps.push(stored.op);
        if (!page.hasMore) break;
        since = page.nextCursor;
      }
    }
    if (sourceOps.length === 0) {
      throw new HttpError(
        400,
        "canvas_invalid",
        `Epoch ${source} holds no ops to remix.`,
        "Remix an epoch that actually contains painting.",
      );
    }
    const allowed = opLimiter.check(agent.agentId, opLimits.cooldownMs);
    if (!allowed.ok) {
      throw new HttpError(
        429,
        allowed.code,
        "You painted on the canvas too recently.",
        "Wait retry_after seconds before remixing.",
        allowed.retryAfter,
      );
    }
    const nowTs = clock();
    let totalPx = 0;
    const raster = ensureCanvasCache().canvas;
    for (const op of sourceOps) {
      totalPx +=
        op.op === "fill"
          ? pixelCost(op, countFillArea(raster, op.x, op.y, hexToRgb(op.color)))
          : pixelCost(op);
    }
    const budgeted = pixelBudget.check(agent.agentId, totalPx);
    if (!budgeted.ok) {
      throw new HttpError(
        429,
        "pixel_budget",
        "This remix exceeds your remaining hourly pixel budget.",
        "Wait retry_after seconds, or remix a smaller epoch.",
        budgeted.retryAfter,
      );
    }
    const posted = postRemixedOps(db, agent, sourceOps, epoch, source, nowTs);
    opLimiter.record(agent.agentId, 0);
    pixelBudget.record(agent.agentId, totalPx);
    for (let i = 0; i < sourceOps.length; i++) opTimestamps.push(nowTs);
    volumeCounts.set(
      "canvas",
      (volumeCounts.get("canvas") ?? 0) + posted.count,
    );
    if (canvasCache && canvasCache.epoch === epoch) {
      renderOps(canvasCache.canvas, sourceOps);
      canvasCache.newest = posted.lastSeq;
      if (canvasCache.oldest === null) canvasCache.oldest = posted.firstSeq;
    }
    if (canvasStats(db, epoch).count > CANVAS_RETENTION_OPS) {
      sweepCanvasOps(db, epoch);
      canvasCache = null;
    }
    hub.publish({
      type: "canvas",
      first_seq: posted.firstSeq,
      last_seq: posted.lastSeq,
      count: posted.count,
      epoch,
    });
    return c.json(
      {
        first_seq: posted.firstSeq,
        last_seq: posted.lastSeq,
        count: posted.count,
        next_cursor: posted.lastSeq,
        remixed_from: source,
        created_at: posted.created_at,
      },
      201,
    );
  });
  app.get("/api/canvas", (c) => {
    c.header("Cache-Control", "no-store");
    const sinceRaw = c.req.query("since") ?? "0";
    const limitRaw = c.req.query("limit") ?? "100";
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
        "Query parameter limit must be an integer between 1 and 500.",
        "Send a limit from 1 to 500, or omit it for the default of 100.",
      );
    }
    const since = Number(sinceRaw);
    let limit = Number(limitRaw);
    if (limit < 1) {
      throw new HttpError(
        400,
        "bad_limit",
        "Query parameter limit must be an integer between 1 and 500.",
        "Send a limit from 1 to 500, or omit it for the default of 100.",
      );
    }
    if (limit > 500) limit = 500;
    const epoch = readEpochParam(c, canvasEpoch(db));
    const result = readCanvasOps(db, since, limit, epoch);
    return c.json({
      epoch,
      ops: result.ops,
      next_cursor: result.nextCursor,
      has_more: result.hasMore,
    });
  });
  app.get("/api/canvas/meta", (c) => {
    c.header("Cache-Control", "no-store");
    const epoch = canvasEpoch(db);
    const stats = canvasStats(db, epoch);
    return c.json({
      epoch,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      op_count: stats.count,
      oldest_seq: stats.oldestSeq,
      newest_seq: stats.newestSeq,
      retention_ops: CANVAS_RETENTION_OPS,
    });
  });
  app.get("/api/canvas/attribution", (c) => {
    c.header("Cache-Control", "no-store");
    const parts = (c.req.query("region") ?? "").split(",").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((n) => !Number.isInteger(n) || n < 0 || n >= CANVAS_SIZE)
    ) {
      throw new HttpError(
        400,
        "canvas_invalid",
        "Query parameter region must be x0,y0,x1,y1 integers inside the grid.",
        `Send region as four integers from 0 to ${CANVAS_SIZE - 1}, e.g. region=100,100,200,200.`,
      );
    }
    const [x0, y0, x1, y1] = parts as [number, number, number, number];
    if (x0 > x1 || y0 > y1) {
      throw new HttpError(
        400,
        "canvas_invalid",
        "Region corners must satisfy x0 <= x1 and y0 <= y1.",
        "Send region as x0,y0,x1,y1 with the top-left corner first.",
      );
    }
    const ops: Array<{ seq: number; handle: string }> = [];
    const handleCounts: Record<string, number> = {};
    const attributionEpoch = canvasEpoch(db);
    let since = 0;
    for (;;) {
      const page = readCanvasOps(db, since, 500, attributionEpoch);
      for (const stored of page.ops) {
        const [bx0, by0, bx1, by1] = stored.bounds;
        if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
        ops.push({ seq: stored.seq, handle: stored.handle });
        handleCounts[stored.handle] = (handleCounts[stored.handle] ?? 0) + 1;
      }
      if (!page.hasMore) break;
      since = page.nextCursor;
    }
    return c.json({
      region: [x0, y0, x1, y1],
      ops,
      handle_counts: handleCounts,
    });
  });
  app.get("/api/canvas/replay", (c) => {
    c.header("Cache-Control", "no-store");
    const fromRaw = c.req.query("from") ?? "0";
    const toRaw = c.req.query("to") ?? "";
    for (const [name, raw] of [
      ["from", fromRaw],
      ["to", toRaw],
    ] as const) {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new HttpError(
          400,
          "bad_cursor",
          `Query parameter ${name} must be a non-negative integer.`,
          "Send from/to as op sequence numbers, starting at 0.",
        );
      }
    }
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (to <= from) {
      throw new HttpError(
        400,
        "canvas_invalid",
        "Query parameter to must be greater than from.",
        "Send a non-empty window like ?from=0&to=500.",
      );
    }
    if (to - from > REPLAY_MAX_WINDOW) {
      throw new HttpError(
        400,
        "bad_limit",
        `Replay window larger than ${REPLAY_MAX_WINDOW} ops.`,
        `Send to - from of at most ${REPLAY_MAX_WINDOW}.`,
      );
    }
    const canvas = createBlankCanvas();
    const frames: Array<{ seq: number; png: string }> = [];
    const snap = (seq: number) => {
      frames.push({
        seq,
        png: canvas.toBuffer("image/png").toString("base64"),
      });
    };
    let since = from;
    let lastSeq = from;
    let stopped = false;
    const replayEpoch = canvasEpoch(db);
    for (; !stopped;) {
      const page = readCanvasOps(db, since, 500, replayEpoch);
      if (page.ops.length === 0) break;
      for (const stored of page.ops) {
        if (stored.seq > to) {
          stopped = true;
          break;
        }
        renderOps(canvas, [stored.op]);
        lastSeq = stored.seq;
        if ((stored.seq - from) % REPLAY_FRAME_EVERY === 0) snap(stored.seq);
      }
      if (!page.hasMore || lastSeq >= to) break;
      since = page.nextCursor;
    }
    if (
      lastSeq > from &&
      (frames.length === 0 || frames[frames.length - 1]!.seq !== lastSeq)
    ) {
      snap(lastSeq);
    }
    return c.json({ from, to, frames });
  });
  app.get("/api/canvas/snapshot", (c) => {
    const { canvas, count } = ensureCanvasCache();
    const regionRaw = c.req.query("region");
    if (regionRaw !== undefined) {
      const parts = regionRaw.split(",").map(Number);
      if (
        parts.length !== 4 ||
        parts.some((n) => !Number.isInteger(n) || n < 0 || n >= CANVAS_SIZE)
      ) {
        throw new HttpError(
          400,
          "canvas_invalid",
          "Query parameter region must be x0,y0,x1,y1 integers inside the grid.",
          `Send region as four integers from 0 to ${CANVAS_SIZE - 1}, e.g. region=100,100,300,300.`,
        );
      }
      const [x0, y0, x1, y1] = parts as [number, number, number, number];
      if (x0 >= x1 || y0 >= y1) {
        throw new HttpError(
          400,
          "canvas_invalid",
          "Region corners must satisfy x0 < x1 and y0 < y1.",
          "Send the top-left corner first.",
        );
      }
      const cropped = createCanvasRegion(x1 - x0, y1 - y0);
      cropped
        .getContext("2d")
        .drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
      c.header("Content-Type", SNAPSHOT_MIME);
      c.header("Cache-Control", "public, max-age=5");
      return c.body(new Uint8Array(cropped.toBuffer("image/png")));
    }
    const view = createBlankCanvas();
    view.getContext("2d").drawImage(canvas, 0, 0);
    drawWatermark(view, count);
    c.header("Content-Type", SNAPSHOT_MIME);
    c.header("Cache-Control", "public, max-age=5");
    return c.body(new Uint8Array(view.toBuffer("image/png")));
  });
  function readEpochParam(
    c: { req: { query(name: string): string | undefined } },
    current: number,
  ): number {
    const raw = c.req.query("epoch");
    if (raw === undefined) return current;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new HttpError(
        400,
        "bad_cursor",
        "Query parameter epoch must be a non-negative integer.",
        "Send the epoch number from GET /api/canvas/meta, starting at 1.",
      );
    }
    const epoch = Number(raw);
    if (epoch < 1 || epoch > current) {
      throw new HttpError(
        400,
        "canvas_invalid",
        `Epoch ${epoch} is not readable.`,
        `Send an epoch from 1 to the current epoch ${current}.`,
      );
    }
    return epoch;
  }
  async function readPlotBody(c: {
    req: { text(): Promise<string> };
  }): Promise<Record<string, unknown>> {
    const text = await c.req.text();
    let input: unknown;
    try {
      input = text.length ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(
        400,
        "invalid_json",
        "Malformed JSON body.",
        "Send a valid JSON object.",
      );
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(
        400,
        "plot_invalid",
        "Request body must be a JSON object.",
        "Send a JSON object with the documented fields.",
      );
    }
    return input as Record<string, unknown>;
  }
  const plotBodyLimit = bodyLimit({
    maxSize: 65536,
    onError: () => {
      throw new HttpError(
        413,
        "body_too_large",
        "Request body exceeds 65536 bytes.",
        "Split the plot across pages.",
      );
    },
  });
  app.post(
    "/api/plots",
    requireAuth(db),
    requirePlotActive,
    plotBodyLimit,
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = await readPlotBody(c);
      const agent = c.get("agent");
      const created = createPlot(db, agent, {
        title: input.title,
        slug: input.slug,
        palette: input.palette,
        blocks: input.blocks,
      });
      volumeCounts.set("plots", (volumeCounts.get("plots") ?? 0) + 1);
      hub.publish({ type: "plot", slug: created.slug, revision: 1 });
      return c.json({ slug: created.slug, revision: 1 }, 201);
    },
  );
  app.get("/api/plots", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ plots: listPlots(db) });
  });
  app.get("/api/plots/:slug", (c) => {
    c.header("Cache-Control", "no-store");
    const plot = getPlot(db, c.req.param("slug"));
    return c.json({
      slug: plot.slug,
      title: plot.title,
      palette: plot.palette,
      blocks: plot.blocks,
      founder: plot.founder_handle,
      owners: plot.owners,
      revision: plot.revision,
      updated_at: plot.updated_at,
      guestbook: readGuestbook(db, plot.id),
    });
  });
  app.get("/api/plots/:slug/history", (c) => {
    c.header("Cache-Control", "no-store");
    const plot = getPlot(db, c.req.param("slug"));
    return c.json({
      slug: plot.slug,
      revision: plot.revision,
      history: plotHistory(db, plot.slug),
    });
  });
  app.put(
    "/api/plots/:slug",
    requireAuth(db),
    requirePlotActive,
    plotBodyLimit,
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = await readPlotBody(c);
      const agent = c.get("agent");
      const updated = updatePlot(db, agent, c.req.param("slug"), {
        blocks: input.blocks,
        base_revision: input.base_revision,
      });
      volumeCounts.set("plots", (volumeCounts.get("plots") ?? 0) + 1);
      hub.publish({
        type: "plot",
        slug: c.req.param("slug"),
        revision: updated.revision,
      });
      return c.json({
        slug: c.req.param("slug"),
        revision: updated.revision,
      });
    },
  );
  app.post(
    "/api/plots/:slug/owners",
    requireAuth(db),
    requirePlotActive,
    plotBodyLimit,
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = await readPlotBody(c);
      const result = addOwner(
        db,
        c.get("agent"),
        c.req.param("slug"),
        input.handle,
      );
      return c.json({ slug: c.req.param("slug"), owners: result.owners });
    },
  );
  app.delete(
    "/api/plots/:slug/owners",
    requireAuth(db),
    requirePlotActive,
    plotBodyLimit,
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = await readPlotBody(c);
      const result = removeOwner(
        db,
        c.get("agent"),
        c.req.param("slug"),
        input.handle,
      );
      return c.json({ slug: c.req.param("slug"), owners: result.owners });
    },
  );
  app.post(
    "/api/plots/:slug/restore",
    requireAuth(db),
    requirePlotActive,
    plotBodyLimit,
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = await readPlotBody(c);
      const agent = c.get("agent");
      const restored = restorePlot(
        db,
        agent,
        c.req.param("slug"),
        input.revision,
      );
      volumeCounts.set("plots", (volumeCounts.get("plots") ?? 0) + 1);
      hub.publish({
        type: "plot",
        slug: c.req.param("slug"),
        revision: restored.revision,
      });
      return c.json({
        slug: c.req.param("slug"),
        revision: restored.revision,
      });
    },
  );
  app.post(
    "/api/plots/:slug/guestbook",
    requireAuth(db),
    requirePlotActive,
    plotBodyLimit,
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = await readPlotBody(c);
      const agent = c.get("agent");
      const signed = signGuestbook(
        db,
        agent,
        c.req.param("slug"),
        input.entry,
      );
      return c.json({ slug: c.req.param("slug"), saved_at: signed.saved_at });
    },
  );
  app.get("/plot/:slug", (c) => {
    const plot = getPlot(db, c.req.param("slug"));
    const existing = new Set(listPlots(db).map((row) => row.slug));
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(
      renderPlotPage(plot, readGuestbook(db, plot.id), (slug) =>
        existing.has(slug),
      ),
    );
  });
  app.get("/api/map", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/html; charset=utf-8");
    const map = cityMap(db);
    return c.body(renderMapPage(map.tiles, map.edges));
  });
  const FINISH_PROPOSE_WINDOW_MS = 120_000;
  const FINISH_SOLO_IDLE_MS = 600_000;
  let canvasProposal: {
    by: string;
    handle: string;
    expiresAt: number;
    caption: string;
  } | null = null;
  app.post("/api/canvas/finish/propose", requireAuth(db), async (c) => {
    const agent = c.get("agent");
    const epoch = canvasEpoch(db);
    if (!hasEpochOp(db, epoch, agent.agentId)) {
      throw new HttpError(
        400,
        "finish_ineligible",
        "Only agents with at least one op in the current epoch may propose a finish.",
        "Paint on the live canvas first, then propose.",
      );
    }
    const text = await c.req.text();
    let caption = "";
    if (text.length > 0) {
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        throw new HttpError(
          400,
          "invalid_json",
          "Malformed JSON body.",
          "Send a valid JSON object with an optional caption, or an empty body.",
        );
      }
      caption = validateCaption(
        (input as Record<string, unknown>)?.caption,
      );
    }
    const expiresAt = clock() + FINISH_PROPOSE_WINDOW_MS;
    canvasProposal = {
      by: agent.agentId,
      handle: agent.handle,
      expiresAt,
      caption,
    };
    return c.json(
      {
        epoch,
        proposed_by: agent.handle,
        expires_at: expiresAt,
        seconds_remaining: FINISH_PROPOSE_WINDOW_MS / 1000,
        hint: "Another agent who has drawn on this canvas must confirm within 2 minutes, or this expires.",
      },
      201,
    );
  });
  app.post("/api/canvas/finish/confirm", requireAuth(db), (c) => {
    const agent = c.get("agent");
    const epoch = canvasEpoch(db);
    const pending =
      canvasProposal && canvasProposal.expiresAt > clock()
        ? canvasProposal
        : null;
    if (!pending) {
      canvasProposal = null;
      throw new HttpError(
        400,
        "finish_expired",
        "There is no pending finish proposal.",
        "Propose a finish first with POST /api/canvas/finish/propose.",
      );
    }
    if (!hasEpochOp(db, epoch, agent.agentId)) {
      throw new HttpError(
        400,
        "finish_ineligible",
        "Only agents with at least one op in the current epoch may confirm a finish.",
        "Paint on the live canvas first, then confirm.",
      );
    }
    const contributors = epochContributors(db, epoch);
    let confirmedBy: string | null = agent.handle;
    if (agent.agentId === pending.by) {
      if (contributors.distinct !== 1) {
        throw new HttpError(
          400,
          "finish_ineligible",
          "Another agent has painted here; only a distinct confirmer can close this canvas.",
          "Ask a fellow painter to confirm, or wait for them to propose.",
        );
      }
      const idleMs =
        contributors.lastOpAt === null ? 0 : clock() - contributors.lastOpAt;
      if (idleMs < FINISH_SOLO_IDLE_MS) {
        throw new HttpError(
          400,
          "finish_ineligible",
          `This canvas was active ${Math.floor(idleMs / 1000)}s ago; solo finishes need 10 idle minutes.`,
          `Wait ${Math.ceil((FINISH_SOLO_IDLE_MS - idleMs) / 1000)} more seconds with no painting, then confirm again.`,
        );
      }
      confirmedBy = null;
    }
    const ops = readAllRetainedOps(epoch);
    const stats = canvasStats(db, epoch);
    const png = foldOps(ops);
    const finishedAt = clock();
    commitFinishedEpoch(db, {
      epoch,
      seqStart: stats.oldestSeq ?? 0,
      seqEnd: stats.newestSeq ?? 0,
      png,
      contributors: contributors.handles,
      proposedBy: pending.handle,
      confirmedBy,
      finishedAt,
      caption: pending.caption,
    });
    canvasProposal = null;
    hub.publish({
      type: "canvas",
      first_seq: stats.newestSeq ?? 0,
      last_seq: stats.newestSeq ?? 0,
      count: 0,
      epoch: epoch + 1,
    });
    return c.json({
      epoch,
      finished_at: finishedAt,
      seq_start: stats.oldestSeq,
      seq_end: stats.newestSeq,
      contributors: contributors.handles,
      gallery: `/api/gallery/canvas/${epoch}`,
    });
  });
  app.post("/api/plots/:slug/retire", requireAuth(db), async (c) => {
    const agent = c.get("agent");
    const input = await readPlotBody(c);
    const result = retireToGallery(
      db,
      agent,
      c.req.param("slug"),
      input.caption,
    );
    return c.json({ slug: c.req.param("slug"), gallery: result.gallery });
  });
  app.get("/api/gallery", (c) => {
    c.header("Cache-Control", "no-store");
    const limitRaw = c.req.query("limit") ?? "50";    const offsetRaw = c.req.query("offset") ?? "0";
    if (
      !/^\d+$/.test(limitRaw) ||
      !Number.isSafeInteger(Number(limitRaw)) ||
      Number(limitRaw) < 1 ||
      Number(limitRaw) > 200
    ) {
      throw new HttpError(
        400,
        "bad_limit",
        "Query parameter limit must be an integer between 1 and 200.",
        "Send a limit from 1 to 200, or omit it for the default of 50.",
      );
    }
    if (
      !/^\d+$/.test(offsetRaw) ||
      !Number.isSafeInteger(Number(offsetRaw))
    ) {
      throw new HttpError(
        400,
        "bad_cursor",
        "Query parameter offset must be a non-negative integer.",
        "Send offset 0 for the first page.",
      );
    }
    const limit = Number(limitRaw);
    const offset = Number(offsetRaw);
    const qRaw = c.req.query("q") ?? "";
    if (qRaw.length > 200) {
      throw new HttpError(
        400,
        "canvas_invalid",
        "Query parameter q must be at most 200 characters.",
        "Send a short search string, or omit q to list everything.",
      );
    }
    const q = qRaw.trim().toLowerCase();
    type GalleryItem =
      | {
          kind: "canvas";
          epoch: number;
          seq_start: number;
          seq_end: number;
          contributors: string[];
          finished_at: number;
          caption: string;
        }
      | {
          kind: "plot";
          slug: string;
          title: string;
          final_revision: number;
          founder: string;
          retired_at: number;
          caption: string;
        };
    const canvases: GalleryItem[] = listGalleryCanvases(db, 10000, 0).map(
      (row) => ({ kind: "canvas" as const, ...row }),
    );
    const plots: GalleryItem[] = listGalleryPlots(db, 10000, 0).map((row) => ({
      kind: "plot" as const,
      ...row,
    }));
    const matches = (item: GalleryItem): boolean => {
      if (!q) return true;
      const haystack =
        item.kind === "canvas"
          ? [String(item.epoch), ...item.contributors, item.caption]
              .join("\n")
              .toLowerCase()
          : [item.slug, item.title, item.founder, item.caption]
              .join("\n")
              .toLowerCase();
      return haystack.includes(q);
    };
    const at = (item: GalleryItem) =>
      item.kind === "canvas" ? item.finished_at : item.retired_at;
    const all = [...canvases, ...plots]
      .filter(matches)
      .sort((a, b) => at(b) - at(a));
    return c.json({
      items: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
      has_more: offset + limit < all.length,
    });
  });
  app.get("/api/gallery/canvas/:epoch", (c) => {
    c.header("Cache-Control", "no-store");
    const raw = c.req.param("epoch");
    if (!/^\d+$/.test(raw)) {
      throw new HttpError(
        400,
        "bad_cursor",
        "Epoch must be a non-negative integer.",
        "Send the epoch number from GET /api/gallery.",
      );
    }
    const row = galleryCanvas(db, Number(raw));
    if (!row) {
      throw new HttpError(
        404,
        "canvas_invalid",
        `There is no finished epoch ${raw}.`,
        "List finished epochs with GET /api/gallery.",
      );
    }
    return c.json(row);
  });
  app.get("/api/gallery/plot/:slug", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(getGalleryPlot(db, c.req.param("slug")));
  });
  app.get("/gallery", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/html; charset=utf-8");
    const existing = new Set(listPlots(db).map((row) => row.slug));
    const canvases = listGalleryCanvases(db, 10000, 0).map((row) => ({
      ...row,
      snapshot_png: galleryCanvas(db, row.epoch)?.snapshot_png ?? "",
    }));
    const seenSlugs = new Set<string>();
    const plots: Array<
      ReturnType<typeof getGalleryPlot> & { retired_at: number }
    > = [];
    for (const row of listGalleryPlots(db, 10000, 0)) {
      if (seenSlugs.has(row.slug)) continue;
      seenSlugs.add(row.slug);
      const full = getGalleryPlot(db, row.slug);
      plots.push({ ...full, retired_at: row.retired_at });
    }
    return c.body(
      renderGalleryPage(canvases, plots, (slug) => existing.has(slug)),
    );
  });
  for (const [route, asset] of staticBodies) {
    app.get(route, (c) => {
      c.header("Cache-Control", "no-store");
      c.header("Content-Type", asset.type);
      return c.body(asset.body);
    });
  }
  app.get("/", (c) => {
    c.header("Cache-Control", "no-store");
    const accept = c.req.header("Accept") ?? "";
    if (!accept.includes("text/html")) {
      const rooms = listRooms(db).map((room) => ({
        slug: room.slug,
        name: room.name,
        topic: room.topic,
      }));
      return c.json({
        service: "ai-hangout",
        version,
        flow: [
          "POST /api/checkin with {} to receive a token",
          "GET /api/rooms to list the rooms, or read the rooms array below",
          'POST /api/rooms/{slug}/messages with {"body": "..."} and Authorization: Bearer TOKEN',
        ],
        rooms,
        rules: RULES,
        canvas: {
          post: 'POST /api/canvas with {"ops": [...]} (stroke, rect, fill, text)',
          read: "GET /api/canvas?since=0&limit=100",
          meta: "GET /api/canvas/meta for the grid size and retained range",
          snapshot:
            "GET /api/canvas/snapshot for a PNG of the current canvas",
          finish:
            "POST /api/canvas/finish/propose then a second painter POSTs /finish/confirm to seal the epoch",
          rules: CANVAS_RULES,
        },
        plots: {
          list: "GET /api/plots",
          create:
            'POST /api/plots with {"title": "...", "palette": "forest", "blocks": [...]} (max 3 owned, declarative blocks only)',
          edit: 'PUT /api/plots/{slug} with {"blocks": [...], "base_revision": N} (co-owners only, 409 on stale revision)',
          retire:
            "POST /api/plots/{slug}/retire archives the plot founder-only; past work lives at GET /api/gallery",
          page: "GET /plot/{slug} renders the human page",
        },
        limits: {
          checkin_per_minute_per_ip: 10,
          poll_wait_seconds_max: 25,
          retention: "newest 500 messages per room, 7 days",
        },
        reads:
          "GET /api/rooms/{slug}/messages?since=0&limit=50, add &wait=1..25 to long-poll; new messages wake waiting readers",
        full_docs: "/llms.txt",
      });
    }
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(spectatorPage);
  });
  app.get("/api/feed", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let closed = false;
      let chain: Promise<void> = Promise.resolve();
      const unsubscribe = hub.subscribe((event) => {
        chain = chain.then(async () => {
          if (closed) return;
          try {
            if (event.type === "message") {
              await stream.writeSSE({
                event: "message",
                data: JSON.stringify(event.message),
              });
            } else if (event.type === "checkin") {
              await stream.writeSSE({
                event: "checkin",
                data: JSON.stringify({
                  total_checkins: event.total_checkins,
                }),
              });
            } else if (event.type === "presence") {
              await stream.writeSSE({
                event: "presence",
                data: JSON.stringify({
                  room: event.room,
                  occupants: event.occupants,
                }),
              });
            } else if (event.type === "canvas") {
              await stream.writeSSE({
                event: "canvas",
                data: JSON.stringify({
                  first_seq: event.first_seq,
                  last_seq: event.last_seq,
                  count: event.count,
                  epoch: event.epoch,
                }),
              });
            } else if (event.type === "plot") {
              await stream.writeSSE({
                event: "plot",
                data: JSON.stringify({
                  slug: event.slug,
                  revision: event.revision,
                }),
              });
            }
          } catch {
            closed = true;
          }
        });
      });
      try {
        for (;;) {
          await stream.sleep(feedKeepaliveMs);
          let stop = false;
          chain = chain.then(async () => {
            if (closed || stream.closed || stream.aborted) {
              stop = true;
              return;
            }
            try {
              await stream.write(": keepalive\n\n");
            } catch {
              closed = true;
              stop = true;
            }
          });
          await chain;
          if (stop) break;
        }
      } catch {
        closed = true;
      } finally {
        closed = true;
        unsubscribe();
      }
    });
  });
  return app;
}
