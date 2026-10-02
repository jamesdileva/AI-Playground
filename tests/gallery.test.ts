import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";
import type { OpLimits, PixelBudgetLimits } from "../src/http/rateLimit.js";
import { postCanvasOps, sweepCanvasOps } from "../src/canvas/queries.js";
import { foldOps } from "../src/canvas/fold.js";
import type { CanvasOp } from "../src/canvas/queries.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Harness = {
  base: string;
  db: Database.Database;
  advance: (ms: number) => void;
};

async function startHarness(
  options: {
    clock?: { now: () => number; advance: (ms: number) => void };
    checkinLimit?: number;
    opLimits?: OpLimits;
    pixelBudgetLimits?: PixelBudgetLimits;
  } = {},
): Promise<Harness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  let time = 1_700_000_000_000;
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit: 10000,
    ...options,
    now: options.clock?.now ?? clock.now,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (db.open) db.close();
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    db,
    advance: options.clock?.advance ?? clock.advance,
  };
}

type Agent = { agent_id: string; handle: string; token: string };

async function newAgent(base: string): Promise<Agent> {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Agent;
}

async function api(
  base: string,
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >,
  };
}

const DOT: CanvasOp[] = [
  { op: "rect", x: 10, y: 10, w: 20, h: 20, color: "#ff8800", fill: true },
];
const RELAXED_OPS: OpLimits = {
  cooldownMs: 0,
  cap: 1_000_000,
  windowMs: 60_000,
};

async function paintTwo(base: string): Promise<[Agent, Agent]> {
  const first = await newAgent(base);
  const second = await newAgent(base);
  expect(
    (await api(base, "POST", "/api/canvas", first.token, { ops: DOT }))
      .status,
  ).toBe(201);
  expect(
    (await api(base, "POST", "/api/canvas", second.token, { ops: DOT }))
      .status,
  ).toBe(201);
  return [first, second];
}

it("10.1 propose plus distinct confirm finishes exactly one epoch", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  const proposed = await api(
    base,
    "POST",
    "/api/canvas/finish/propose",
    first.token,
  );
  expect(proposed.status).toBe(201);
  expect(proposed.json.epoch).toBe(1);
  expect(proposed.json.proposed_by).toBe(first.handle);
  const confirmed = await api(
    base,
    "POST",
    "/api/canvas/finish/confirm",
    second.token,
  );
  expect(confirmed.status).toBe(200);
  expect(confirmed.json.epoch).toBe(1);
  expect(confirmed.json.gallery).toBe("/api/gallery/canvas/1");
  const gallery = (await (await fetch(`${base}/api/gallery`)).json()) as {
    items: unknown[];
    total: number;
  };
  expect(gallery.total).toBe(1);
  expect(gallery.items).toHaveLength(1);
  const live = (await (await fetch(`${base}/api/canvas?since=0`)).json()) as {
    epoch: number;
    ops: unknown[];
  };
  expect(live.epoch).toBe(2);
  expect(live.ops).toEqual([]);
  const meta = (await (await fetch(`${base}/api/canvas/meta`)).json()) as {
    epoch: number;
    op_count: number;
  };
  expect(meta.epoch).toBe(2);
  expect(meta.op_count).toBe(0);
  const stats = (await (await fetch(`${base}/api/stats`)).json()) as {
    finished_canvases: number;
  };
  expect(stats.finished_canvases).toBe(1);
});

it("10.2 solo confirm rejected early, accepted after the idle window", async () => {
  const { base, advance } = await startHarness({ opLimits: RELAXED_OPS });
  const agent = await newAgent(base);
  expect(
    (await api(base, "POST", "/api/canvas", agent.token, { ops: DOT }))
      .status,
  ).toBe(201);
  expect(
    (await api(base, "POST", "/api/canvas/finish/propose", agent.token))
      .status,
  ).toBe(201);
  const early = await api(
    base,
    "POST",
    "/api/canvas/finish/confirm",
    agent.token,
  );
  expect(early.status).toBe(400);
  advance(601_000);
  expect(
    (await api(base, "POST", "/api/canvas/finish/propose", agent.token))
      .status,
  ).toBe(201);
  const late = await api(
    base,
    "POST",
    "/api/canvas/finish/confirm",
    agent.token,
  );
  expect(late.status).toBe(200);
  const detail = (await (
    await fetch(`${base}/api/gallery/canvas/1`)
  ).json()) as { confirmed_by: string | null };
  expect(detail.confirmed_by).toBeNull();
});

it("10.3 agents with zero epoch ops cannot propose or confirm", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first] = await paintTwo(base);
  const stranger = await newAgent(base);
  const proposed = await api(
    base,
    "POST",
    "/api/canvas/finish/propose",
    stranger.token,
  );
  expect(proposed.status).toBe(400);
  expect(proposed.json.error).toBe("finish_ineligible");
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  const confirmed = await api(
    base,
    "POST",
    "/api/canvas/finish/confirm",
    stranger.token,
  );
  expect(confirmed.status).toBe(400);
  expect(confirmed.json.error).toBe("finish_ineligible");
});

it("10.4 lapsed proposals expire; painting continues normally", async () => {
  const { base, advance } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  expect(
    (await api(base, "POST", "/api/canvas/finish/propose", first.token))
      .status,
  ).toBe(201);
  advance(121_000);
  const lapsed = await api(
    base,
    "POST",
    "/api/canvas/finish/confirm",
    second.token,
  );
  expect(lapsed.status).toBe(400);
  expect(lapsed.json.error).toBe("finish_expired");
  expect(
    (await api(base, "POST", "/api/canvas", first.token, { ops: DOT }))
      .status,
  ).toBe(201);
  const gallery = (await (await fetch(`${base}/api/gallery`)).json()) as {
    total: number;
  };
  expect(gallery.total).toBe(0);
});

it("10.5 gallery snapshot pixel-matches an independent fold", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  const third = await newAgent(base);
  const batch: CanvasOp[] = [
    {
      op: "stroke",
      pts: [
        [12, 40],
        [80, 90],
        [200, 120],
      ],
      color: "#88aaff",
      width: 3,
    },
    {
      op: "text",
      x: 60,
      y: 30,
      text: "epoch one",
      color: "#ffffff",
      size: 12,
    },
  ];
  expect(
    (await api(base, "POST", "/api/canvas", third.token, { ops: batch }))
      .status,
  ).toBe(201);
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  expect(
    (await api(base, "POST", "/api/canvas/finish/confirm", second.token))
      .status,
  ).toBe(200);
  const log = (await (
    await fetch(`${base}/api/canvas?since=0&epoch=1&limit=500`)
  ).json()) as { ops: Array<{ op: CanvasOp }> };
  const expected = foldOps(log.ops.map((stored) => stored.op));
  const detail = (await (
    await fetch(`${base}/api/gallery/canvas/1`)
  ).json()) as {
    epoch: number;
    seq_start: number;
    seq_end: number;
    snapshot_png: string;
    contributors: string[];
  };
  expect(detail.epoch).toBe(1);
  expect(detail.contributors.sort()).toEqual(
    [first.handle, second.handle, third.handle].sort(),
  );
  expect(Buffer.from(detail.snapshot_png, "base64").equals(expected)).toBe(
    true,
  );
});

it("10.6 past epochs read; writes to them are rejected", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const past = (await (
    await fetch(`${base}/api/canvas?since=0&epoch=1`)
  ).json()) as { ops: unknown[]; epoch: number };
  expect(past.epoch).toBe(1);
  expect(past.ops).toHaveLength(2);
  const live = (await (await fetch(`${base}/api/canvas?since=0`)).json()) as {
    ops: unknown[];
    epoch: number;
  };
  expect(live.epoch).toBe(2);
  expect(live.ops).toEqual([]);
  const stale = await api(base, "POST", "/api/canvas?epoch=1", first.token, {
    ops: DOT,
  });
  expect(stale.status).toBe(400);
  const current = await api(base, "POST", "/api/canvas", first.token, {
    ops: DOT,
  });
  expect(current.status).toBe(201);
  const future = await fetch(`${base}/api/canvas?since=0&epoch=9`);
  expect(future.status).toBe(400);
});

it("10.7 sweeps touch only the current epoch", async () => {
  const { base, db } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  for (let n = 0; n < 100; n++) {
    postCanvasOps(
      db,
      { agentId: first.agent_id, handle: first.handle },
      DOT,
      1,
    );
  }
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  for (let n = 0; n < 20500; n++) {
    postCanvasOps(
      db,
      { agentId: second.agent_id, handle: second.handle },
      DOT,
      2,
    );
  }
  const deleted = sweepCanvasOps(db, 2);
  expect(deleted).toBe(500);
  const old = (await (
    await fetch(`${base}/api/canvas?since=0&epoch=1&limit=500`)
  ).json()) as { ops: unknown[] };
  expect(old.ops.length).toBe(102);
  const meta = (await (await fetch(`${base}/api/canvas/meta`)).json()) as {
    op_count: number;
  };
  expect(meta.op_count).toBe(20000);
}, 60_000);

it("10.9 non-founder retirement is 403, founder retires", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const friend = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Mine",
    blocks: [{ type: "text", text: "v1" }],
  });
  const slug = created.json.slug as string;
  await api(base, "POST", `/api/plots/${slug}/owners`, founder.token, {
    handle: friend.handle,
  });
  const denied = await api(
    base,
    "POST",
    `/api/plots/${slug}/retire`,
    friend.token,
  );
  expect(denied.status).toBe(403);
  const retired = await api(
    base,
    "POST",
    `/api/plots/${slug}/retire`,
    founder.token,
  );
  expect(retired.status).toBe(200);
  expect(retired.json.gallery).toBe(`/api/gallery/plot/${slug}`);
  const stats = (await (await fetch(`${base}/api/stats`)).json()) as {
    retired_plots: number;
  };
  expect(stats.retired_plots).toBe(1);
});

it("10.10 retired slugs are reusable and the cap counts live plots", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const slugs: string[] = [];
  for (const title of ["P1", "P2", "P3"]) {
    const created = await api(base, "POST", "/api/plots", founder.token, {
      title,
      blocks: [{ type: "text", text: "v1" }],
    });
    expect(created.status).toBe(201);
    slugs.push(created.json.slug as string);
  }
  const fourth = await api(base, "POST", "/api/plots", founder.token, {
    title: "P4",
    blocks: [{ type: "text", text: "v1" }],
  });
  expect(fourth.status).toBe(429);
  expect(
    (await api(base, "POST", `/api/plots/${slugs[0]}/retire`, founder.token))
      .status,
  ).toBe(200);
  const reused = await api(base, "POST", "/api/plots", founder.token, {
    title: "Reuse",
    slug: slugs[0],
    blocks: [{ type: "text", text: "reborn" }],
  });
  expect(reused.status).toBe(201);
  expect(reused.json.slug).toBe(slugs[0]);
  const live = (await (await fetch(`${base}/api/plots`)).json()) as {
    plots: unknown[];
  };
  expect(live.plots).toHaveLength(3);
});

it("10.11 retired plots answer 410 with a resolvable gallery URL", async () => {
  const { base } = await startHarness();
  const founder = await newAgent(base);
  const friend = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Doomed",
    blocks: [{ type: "text", text: "v1" }],
  });
  const slug = created.json.slug as string;
  await api(base, "POST", `/api/plots/${slug}/owners`, founder.token, {
    handle: friend.handle,
  });
  expect(
    (await api(base, "POST", `/api/plots/${slug}/retire`, founder.token))
      .status,
  ).toBe(200);
  const write = await api(base, "PUT", `/api/plots/${slug}`, friend.token, {
    blocks: [{ type: "text", text: "too late" }],
    base_revision: 1,
  });
  expect(write.status).toBe(410);
  expect(write.json.error).toBe("plot_retired");
  const galleryUrl = write.json.gallery as string;
  const archived = await fetch(`${base}${galleryUrl}`);
  expect(archived.status).toBe(200);
  const detail = (await archived.json()) as {
    slug: string;
    blocks: unknown;
    final_revision: number;
  };
  expect(detail.slug).toBe(slug);
  expect(detail.final_revision).toBe(1);
});

it("10.12 gallery has no write routes", async () => {
  const { base } = await startHarness();
  for (const [method, path] of [
    ["POST", "/api/gallery"],
    ["PUT", "/api/gallery"],
    ["DELETE", "/api/gallery"],
    ["POST", "/api/gallery/canvas/1"],
    ["PUT", "/api/gallery/canvas/1"],
    ["DELETE", "/api/gallery/canvas/1"],
    ["POST", "/api/gallery/plot/nope"],
    ["PUT", "/api/gallery/plot/nope"],
    ["DELETE", "/api/gallery/plot/nope"],
  ] as Array<[string, string]>) {
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status, `${method} ${path}`).toBe(404);
  }
});

it("10.13 sweeps leave gallery content byte-identical", async () => {
  const { base, db } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const founder = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Archive me",
    blocks: [{ type: "text", text: "keep" }],
  });
  const slug = created.json.slug as string;
  await api(base, "POST", `/api/plots/${slug}/retire`, founder.token);
  const { sweepRetention } = await import("../src/room/queries.js");
  const canvasBefore = await (
    await fetch(`${base}/api/gallery/canvas/1`)
  ).json();
  const plotBefore = await (
    await fetch(`${base}/api/gallery/plot/${slug}`)
  ).json();
  sweepRetention(db);
  sweepCanvasOps(db, 2);
  const canvasAfter = await (
    await fetch(`${base}/api/gallery/canvas/1`)
  ).json();
  const plotAfter = await (
    await fetch(`${base}/api/gallery/plot/${slug}`)
  ).json();
  expect(canvasAfter).toEqual(canvasBefore);
  expect(plotAfter).toEqual(plotBefore);
  const meta = (await (await fetch(`${base}/api/canvas/meta`)).json()) as {
    op_count: number;
  };
  expect(meta.op_count).toBe(0);
});

it("10.15 fifty concurrent paints partition exactly across the boundary", async () => {
  const one = (idx: number) => ({
    ops: [
      {
        op: "rect",
        x: idx % 900,
        y: 10,
        w: 20,
        h: 20,
        color: "#ff8800",
        fill: true,
      },
    ],
  });
  for (let round = 1; round <= 5; round++) {
    const { base } = await startHarness({
      opLimits: RELAXED_OPS,
      pixelBudgetLimits: { budgetPx: 100_000_000, windowMs: 3_600_000 },
    });
    const painters = await Promise.all(
      Array.from({ length: 50 }, () => newAgent(base)),
    );
    for (const [idx, agent] of painters.entries()) {
      expect(
        (await api(base, "POST", "/api/canvas", agent.token, one(idx)))
          .status,
      ).toBe(201);
    }
    expect(
      (
        await api(
          base,
          "POST",
          "/api/canvas/finish/propose",
          painters[0]!.token,
        )
      ).status,
    ).toBe(201);
    const results = await Promise.all([
      ...painters.map((agent, idx) =>
        api(base, "POST", "/api/canvas", agent.token, one(idx)),
      ),
      api(base, "POST", "/api/canvas/finish/confirm", painters[1]!.token),
    ]);
    const paints = results.slice(0, 50);
    const confirm = results[50] as { status: number };
    expect(paints.every((result) => result.status === 201)).toBe(true);
    expect(confirm.status).toBe(200);
    const oldOps = (
      (await (
        await fetch(`${base}/api/canvas?since=0&epoch=1&limit=500`)
      ).json()) as { ops: Array<{ seq: number }> }
    ).ops.map((op) => op.seq);
    const newOps = (
      (await (
        await fetch(`${base}/api/canvas?since=0&epoch=2&limit=500`)
      ).json()) as { ops: Array<{ seq: number }> }
    ).ops.map((op) => op.seq);
    expect(oldOps.length + newOps.length).toBe(100);
    const union = [...oldOps, ...newOps].sort((a, b) => a - b);
    expect(union.length).toBe(100);
    expect(new Set(union).size).toBe(100);
  }
}, 180_000);

it("10.8 killing the server mid-retire never leaves partial state", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "hangout-kill-"));
  try {
    const dbPath = join(directory, "hangout.db");
    const port = 3271;
    const base = `http://127.0.0.1:${port}`;
    const server: ChildProcess = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          DB_PATH: dbPath,
        },
        stdio: "ignore",
      },
    );
    try {
      let healthy = false;
      for (let i = 0; i < 120 && !healthy; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const res = await fetch(`${base}/api/health`);
          healthy = res.ok;
        } catch {
          continue;
        }
      }
      expect(healthy).toBe(true);
      const checkin = await fetch(`${base}/api/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const token = ((await checkin.json()) as { token: string }).token;
      const killAfter = 100 + Math.random() * 500;
      const killer = setTimeout(() => {
        try {
          server.kill("SIGKILL");
        } catch {
          return;
        }
      }, killAfter);
      let cycles = 0;
      let dead = false;
      server.on("exit", () => {
        dead = true;
      });
      const headers = {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      while (!dead && cycles < 200) {
        cycles++;
        try {
          const created = await fetch(`${base}/api/plots`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: `Kill plot ${cycles}`,
              blocks: [{ type: "text", text: "fragile" }],
            }),
          });
          if (created.status !== 201) break;
          const slug = ((await created.json()) as { slug: string }).slug;
          const retired = await fetch(`${base}/api/plots/${slug}/retire`, {
            method: "POST",
            headers,
            body: "{}",
          });
          if (retired.status !== 200) break;
        } catch {
          break;
        }
      }
      clearTimeout(killer);
      const { execFileSync } = await import("node:child_process");
      for (let i = 0; i < 150 && !dead; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (server.exitCode !== null) dead = true;
        else {
          try {
            server.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          try {
            execFileSync("taskkill", ["/PID", String(server.pid), "/F"], {
              stdio: "ignore",
            });
            dead = true;
          } catch {
            /* taskkill only exists on Windows; ignore */
          }
        }
      }
      expect(dead).toBe(true);
      expect(cycles).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let db: Database.Database | null = null;
      for (let attempt = 0; attempt < 10 && !db; attempt++) {
        try {
          db = openDatabase(dbPath);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!db) throw new Error("Could not reopen the killed database");
      try {
        const both = db
          .prepare(
            "SELECT slug FROM plots INTERSECT SELECT original_slug FROM gallery_plots",
          )
          .all();
        expect(both).toEqual([]);
        for (const table of [
          "plot_owners",
          "plot_guestbook",
          "plot_revisions",
        ]) {
          const orphans = db
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE plot_id NOT IN (SELECT id FROM plots)`,
            )
            .get() as { count: number };
          expect(orphans.count, table).toBe(0);
        }
        const live = (
          db.prepare("SELECT COUNT(*) AS count FROM plots").get() as {
            count: number;
          }
        ).count;
        const archived = (
          db.prepare("SELECT COUNT(*) AS count FROM gallery_plots").get() as {
            count: number;
          }
        ).count;
        expect(live + archived).toBeGreaterThanOrEqual(cycles - 1);
        expect(live + archived).toBeLessThanOrEqual(cycles);
      } finally {
        if (db.open) db.close();
      }
    } finally {
      try {
        server.kill("SIGKILL");
      } catch {
        /* Server already dead; teardown is complete. */
      }
    }
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(directory, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}, 120_000);

it("12.1 remix replays a finished epoch live with provenance", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const mixer = await newAgent(base);
  const remixed = await api(base, "POST", "/api/canvas/remix", mixer.token, {
    epoch: 1,
  });
  expect(remixed.status).toBe(201);
  expect(remixed.json).toMatchObject({ remixed_from: 1, count: 2 });
  const live = (await (await fetch(`${base}/api/canvas?since=0`)).json()) as {
    epoch: number;
    ops: Array<{ op: { op: string } & Record<string, unknown> }>;
  };
  expect(live.epoch).toBe(2);
  expect(live.ops).toHaveLength(2);
  for (const stored of live.ops) {
    expect(stored.op.remixed_from).toBe(1);
  }
  const snapshot = await fetch(`${base}/api/canvas/snapshot`);
  expect(snapshot.status).toBe(200);
});

it("12.2 remix of live or missing epochs is rejected", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  const current = await api(base, "POST", "/api/canvas/remix", first.token, {
    epoch: 1,
  });
  expect(current.status).toBe(400);
  const missing = await api(base, "POST", "/api/canvas/remix", first.token, {
    epoch: 99,
  });
  expect(missing.status).toBe(400);
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const unauth = await api(base, "POST", "/api/canvas/remix", undefined, {
    epoch: 1,
  });
  expect(unauth.status).toBe(401);
});

it("12.3 remixed ops grant no finish rights but cost budget", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const mixer = await newAgent(base);
  expect(
    (await api(base, "POST", "/api/canvas/remix", mixer.token, { epoch: 1 }))
      .status,
  ).toBe(201);
  const proposer = await api(
    base,
    "POST",
    "/api/canvas/finish/propose",
    mixer.token,
  );
  expect(proposer.status).toBe(400);
  expect(proposer.json.error).toBe("finish_ineligible");
});

it("12.3b remix spend counts against the pixel budget", async () => {
  const { base } = await startHarness({
    opLimits: RELAXED_OPS,
    pixelBudgetLimits: {
      budgetPx: 500,
      windowMs: 3_600_000,
    },
  });
  const [first, second] = await paintTwo(base);
  await api(base, "POST", "/api/canvas/finish/propose", first.token);
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const mixer = await newAgent(base);
  const over = await api(base, "POST", "/api/canvas/remix", mixer.token, {
    epoch: 1,
  });
  expect(over.status).toBe(429);
  expect(over.json.error).toBe("pixel_budget");
});

it("12.5 captions store, render escaped, and reject overflow", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  const probe = '<img src=x onerror="alert(1)">';
  const tooLong = await api(
    base,
    "POST",
    "/api/canvas/finish/propose",
    first.token,
    {
      caption: "x".repeat(501),
    },
  );
  expect(tooLong.status).toBe(400);
  await api(base, "POST", "/api/canvas/finish/propose", first.token, {
    caption: `sunset study ${probe}`,
  });
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const detail = (await (
    await fetch(`${base}/api/gallery/canvas/1`)
  ).json()) as { caption: string };
  expect(detail.caption).toBe(`sunset study ${probe}`);
  const founder = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Captioned",
    blocks: [{ type: "text", text: "hi" }],
  });
  const slug = created.json.slug as string;
  const retired = await api(
    base,
    "POST",
    `/api/plots/${slug}/retire`,
    founder.token,
    {
      caption: `about loss ${probe}`,
    },
  );
  expect(retired.status).toBe(200);
  const archived = (await (
    await fetch(`${base}/api/gallery/plot/${slug}`)
  ).json()) as { caption: string };
  expect(archived.caption).toBe(`about loss ${probe}`);
  const page = await fetch(`${base}/gallery`);
  const html = await page.text();
  expect(html).not.toContain(probe);
  expect(html).toContain("sunset study");
  expect(html).toContain("about loss");
});

it("12.6 gallery search finds by caption, title, and handle", async () => {
  const { base } = await startHarness({ opLimits: RELAXED_OPS });
  const [first, second] = await paintTwo(base);
  await api(base, "POST", "/api/canvas/finish/propose", first.token, {
    caption: "harbor lights",
  });
  await api(base, "POST", "/api/canvas/finish/confirm", second.token);
  const founder = await newAgent(base);
  const created = await api(base, "POST", "/api/plots", founder.token, {
    title: "Lighthouse Log",
    blocks: [{ type: "text", text: "hi" }],
  });
  const slug = created.json.slug as string;
  await api(base, "POST", `/api/plots/${slug}/retire`, founder.token, {
    caption: "storm stories",
  });
  const byCaption = (await (
    await fetch(`${base}/api/gallery?q=harbor`)
  ).json()) as { items: Array<{ kind: string }>; total: number };
  expect(byCaption.total).toBe(1);
  expect(byCaption.items[0]).toMatchObject({ kind: "canvas", epoch: 1 });
  const byTitle = (await (
    await fetch(`${base}/api/gallery?q=lighthouse`)
  ).json()) as { total: number };
  expect(byTitle.total).toBe(1);
  const byHandle = (await (
    await fetch(`${base}/api/gallery?q=${founder.handle}`)
  ).json()) as { total: number };
  expect(byHandle.total).toBe(1);
  const missing = (await (
    await fetch(`${base}/api/gallery?q=zzzz-no-such-thing`)
  ).json()) as { items: unknown[]; total: number };
  expect(missing.total).toBe(0);
  expect(missing.items).toEqual([]);
  const all = (await (await fetch(`${base}/api/gallery`)).json()) as {
    total: number;
  };
  expect(all.total).toBe(2);
  const tooLong = await fetch(`${base}/api/gallery?q=${"x".repeat(201)}`);
  expect(tooLong.status).toBe(400);
});

it("12.7 migration 006 upgrades a v5 database losslessly", async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const Database = (await import("better-sqlite3")).default;
  const directory = mkdtempSync(join(tmpdir(), "hangout-upgrade-"));
  try {
    const path = join(directory, "hangout.db");
    const old = new Database(path);
    try {
      const root = new URL("../migrations/", import.meta.url);
      for (const file of [
        "001_init.sql",
        "002_seed_rooms.sql",
        "003_canvas.sql",
        "004_plots.sql",
        "005_gallery.sql",
      ]) {
        old.exec(readFileSync(new URL(file, root), "utf8"));
        const version = {
          "001_init.sql": 1,
          "002_seed_rooms.sql": 2,
          "003_canvas.sql": 3,
          "004_plots.sql": 4,
          "005_gallery.sql": 5,
        }[file]!;
        old.pragma(`user_version = ${version}`);
      }
      old
        .prepare(
          "INSERT INTO canvas_ops (agent_id, handle, op_type, op_json, bounds, created_at, epoch) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "agent-1",
          "amy",
          "rect",
          JSON.stringify({
            op: "rect",
            x: 1,
            y: 1,
            w: 2,
            h: 2,
            color: "#111111",
            fill: true,
          }),
          JSON.stringify([1, 1, 3, 3]),
          1000,
          1,
        );
    } finally {
      old.close();
    }
    const db = openDatabase(path);
    try {
      const { migrations } = await import("../src/database.js");
      expect(db.pragma("user_version", { simple: true }) as number).toBe(
        migrations.length,
      );
      const columns = db
        .prepare("PRAGMA table_info(canvas_ops)")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("remixed_from");
      const ops = db
        .prepare("SELECT op_json FROM canvas_ops")
        .all() as Array<{ op_json: string }>;
      expect(ops).toHaveLength(1);
      expect(JSON.parse(ops[0]!.op_json)).toMatchObject({ op: "rect" });
    } finally {
      if (db.open) db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
