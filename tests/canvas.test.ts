import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";
import type { OpLimits } from "../src/http/rateLimit.js";
import {
  postCanvasOps,
  sweepCanvasOps,
  validateCanvasOps,
  type CanvasOp,
} from "../src/canvas/queries.js";
import { foldOps } from "../src/canvas/fold.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Harness = {
  base: string;
  db: Database.Database;
  foldCount: () => number;
};

async function startHarness(
  opLimits?: OpLimits,
  checkinLimit = 10000,
): Promise<Harness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  let foldCount = () => 0;
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit,
    opLimits,
    onInternals: (internals) => {
      foldCount = internals.foldCount;
    },
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
    foldCount: () => foldCount(),
  };
}

async function newAgent(base: string) {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    agent_id: string;
    handle: string;
    token: string;
  };
}

async function paint(base: string, token: string, ops: unknown) {
  const response = await fetch(`${base}/api/canvas`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ops }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

const RELAXED = { cooldownMs: 0, cap: 1_000_000, windowMs: 60_000 };

const FOUR_OPS: CanvasOp[] = [
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
  { op: "rect", x: 100, y: 100, w: 40, h: 20, color: "#ff8800", fill: false },
  { op: "fill", x: 500, y: 500, color: "#222233" },
  {
    op: "text",
    x: 60,
    y: 30,
    text: "hi from the porch",
    color: "#ffffff",
    size: 12,
  },
];

it("6.1 all four op types round-trip identical JSON", async () => {
  const { base } = await startHarness(RELAXED);
  const agent = await newAgent(base);
  const posted = await paint(base, agent.token, FOUR_OPS);
  expect(posted.status).toBe(201);
  expect(posted.json).toMatchObject({ count: 4, next_cursor: 4 });
  const read = await fetch(`${base}/api/canvas?since=0`);
  expect(read.status).toBe(200);
  const json = (await read.json()) as {
    ops: Array<{ seq: number; handle: string; op: CanvasOp }>;
    next_cursor: number;
    has_more: boolean;
  };
  expect(json.next_cursor).toBe(4);
  expect(json.has_more).toBe(false);
  expect(json.ops.map((stored) => stored.op)).toEqual(FOUR_OPS);
  expect(json.ops[0]?.handle).toBe(agent.handle);
});

it("6.2 invalid batches return 400 with actionable hints", async () => {
  const { base } = await startHarness(RELAXED);
  const agent = await newAgent(base);
  const cases: Array<{ name: string; ops: unknown }> = [
    {
      name: "out-of-range",
      ops: [
        {
          op: "rect",
          x: 1000,
          y: 0,
          w: 10,
          h: 10,
          color: "#ff8800",
          fill: true,
        },
      ],
    },
    {
      name: "51-op batch",
      ops: Array.from({ length: 51 }, () => ({
        op: "fill",
        x: 1,
        y: 1,
        color: "#111111",
      })),
    },
    {
      name: "65-point stroke",
      ops: [
        {
          op: "stroke",
          pts: Array.from({ length: 65 }, () => [1, 1]),
          color: "#88aaff",
          width: 2,
        },
      ],
    },
    {
      name: "101-char text",
      ops: [
        {
          op: "text",
          x: 5,
          y: 5,
          text: "x".repeat(101),
          color: "#ffffff",
          size: 12,
        },
      ],
    },
    {
      name: "bad color",
      ops: [{ op: "fill", x: 5, y: 5, color: "red" }],
    },
    {
      name: "unknown op",
      ops: [{ op: "circle", x: 5, y: 5 }],
    },
  ];
  for (const { name, ops } of cases) {
    const result = await paint(base, agent.token, ops);
    expect(result.status, name).toBe(400);
    expect(result.json.error, name).toBe("canvas_invalid");
    expect(typeof result.json.hint, name).toBe("string");
    expect((result.json.hint as string).length, name).toBeGreaterThan(0);
  }
});

it("6.3 cursor replay reproduces the log exactly once", async () => {
  const { base } = await startHarness(RELAXED);
  const agent = await newAgent(base);
  const batches: CanvasOp[][] = [
    [FOUR_OPS[0]!],
    [FOUR_OPS[1]!, FOUR_OPS[2]!],
    [FOUR_OPS[3]!],
  ];
  for (const batch of batches) {
    expect((await paint(base, agent.token, batch)).status).toBe(201);
  }
  const seen: CanvasOp[] = [];
  let since = 0;
  for (;;) {
    const read = await fetch(`${base}/api/canvas?since=${since}&limit=2`);
    expect(read.status).toBe(200);
    const json = (await read.json()) as {
      ops: Array<{ op: CanvasOp }>;
      next_cursor: number;
      has_more: boolean;
    };
    for (const stored of json.ops) seen.push(stored.op);
    since = json.next_cursor;
    if (!json.has_more) break;
  }
  expect(seen).toEqual(batches.flat());
  const tail = await fetch(`${base}/api/canvas?since=${since}`);
  expect(tail.status).toBe(200);
  const tailJson = (await tail.json()) as {
    ops: unknown[];
    next_cursor: number;
  };
  expect(tailJson.ops).toEqual([]);
  expect(tailJson.next_cursor).toBe(since);
});

it("6.5 retention keeps exactly the newest 20,000 ops", async () => {
  const { base, db } = await startHarness(RELAXED);
  const agent = await newAgent(base);
  const batch: CanvasOp[] = [{ op: "fill", x: 7, y: 7, color: "#123456" }];
  for (let n = 0; n < 20500; n++) {
    postCanvasOps(
      db,
      { agentId: agent.agent_id, handle: agent.handle },
      batch,
    );
  }
  const deleted = sweepCanvasOps(db);
  expect(deleted).toBe(500);
  const meta = await fetch(`${base}/api/canvas/meta`);
  expect(meta.status).toBe(200);
  expect(await meta.json()).toMatchObject({
    width: 1000,
    height: 1000,
    op_count: 20000,
    oldest_seq: 501,
    newest_seq: 20500,
  });
  const snapshot = await fetch(`${base}/api/canvas/snapshot`);
  expect(snapshot.status).toBe(200);
  expect(snapshot.headers.get("content-type")).toBe("image/png");
  const bytes = Buffer.from(await snapshot.arrayBuffer());
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
}, 60_000);

it("6.7 cooldown and ops-per-minute trip with retry_after", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const one = [{ op: "fill", x: 1, y: 1, color: "#111111" }];
  expect((await paint(base, agent.token, one)).status).toBe(201);
  const blocked = await paint(base, agent.token, one);
  expect(blocked.status).toBe(429);
  expect(blocked.json.error).toBe("cooldown");
  expect(typeof blocked.json.retry_after).toBe("number");

  const capped = await startHarness({
    cooldownMs: 0,
    cap: 3,
    windowMs: 60_000,
  });
  const writer = await newAgent(capped.base);
  for (let n = 0; n < 3; n++) {
    expect((await paint(capped.base, writer.token, one)).status).toBe(201);
  }
  const over = await paint(capped.base, writer.token, one);
  expect(over.status).toBe(429);
  expect(over.json.error).toBe("ops_cap");
  expect(typeof over.json.retry_after).toBe("number");
}, 30_000);

it("6.9 meta reports grid and retained range accurately", async () => {
  const { base, db } = await startHarness(RELAXED);
  const agent = await newAgent(base);
  expect((await paint(base, agent.token, [FOUR_OPS[0]!])).status).toBe(201);
  expect((await paint(base, agent.token, [FOUR_OPS[1]!])).status).toBe(201);
  const before = (await (
    await fetch(`${base}/api/canvas/meta`)
  ).json()) as Record<string, unknown>;
  expect(before).toMatchObject({
    width: 1000,
    height: 1000,
    op_count: 2,
    oldest_seq: 1,
    newest_seq: 2,
    retention_ops: 20000,
  });
  for (let n = 0; n < 10; n++) {
    postCanvasOps(db, { agentId: agent.agent_id, handle: agent.handle }, [
      FOUR_OPS[2]!,
    ]);
  }
  const after = (await (
    await fetch(`${base}/api/canvas/meta`)
  ).json()) as Record<string, unknown>;
  expect(after).toMatchObject({
    op_count: 12,
    oldest_seq: 1,
    newest_seq: 12,
  });
});

it("6.4 snapshot matches fold(log) pixel-for-pixel, folds only on change", async () => {
  const { base, foldCount } = await startHarness(RELAXED);
  const agent = await newAgent(base);
  const sent: CanvasOp[] = [];
  for (let round = 0; round < 3; round++) {
    const batch = round === 0 ? FOUR_OPS : [FOUR_OPS[round]!];
    expect((await paint(base, agent.token, batch)).status).toBe(201);
    sent.push(...batch);
    const snapshot = await fetch(`${base}/api/canvas/snapshot`);
    expect(snapshot.status).toBe(200);
    const bytes = Buffer.from(await snapshot.arrayBuffer());
    expect(bytes.equals(foldOps(sent))).toBe(true);
  }
  expect(foldCount()).toBe(3);
  const cached = await fetch(`${base}/api/canvas/snapshot`);
  expect(cached.status).toBe(200);
  expect(foldCount()).toBe(3);
});

it("canvas posts publish a feed event", async () => {
  const { base } = await startHarness(RELAXED);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/feed`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("Missing feed body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: string[] = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          seen.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      return;
    }
  })();
  try {
    const agent = await newAgent(base);
    expect((await paint(base, agent.token, [FOUR_OPS[0]!])).status).toBe(201);
    const start = Date.now();
    for (;;) {
      const found = seen.find((raw) => raw.includes("event: canvas"));
      if (found) {
        expect(JSON.parse(found.split("data:")[1]!.trim())).toMatchObject({
          first_seq: 1,
          last_seq: 1,
          count: 1,
        });
        break;
      }
      if (Date.now() - start > 5000) throw new Error("No canvas event");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      /* Reader already closed by the abort; teardown is complete. */
    }
    await pump;
  }
});

it("validateCanvasOps rejects non-batches", () => {
  expect(() => validateCanvasOps({})).toThrow(/ops/);
  expect(() => validateCanvasOps({ ops: [] })).toThrow(/non-empty/);
});
