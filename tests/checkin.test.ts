import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { isHandleClean } from "../src/door/handles.js";
import { hashToken } from "../src/door/tokens.js";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";
import { requireAuth } from "../src/http/auth.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Harness = {
  base: string;
  logs: LogEntry[];
  db: Database.Database;
};
async function startHarness(
  checkinLimit = 10,
  now?: () => number,
): Promise<Harness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit,
    now,
  });
  app.get("/test-auth", requireAuth(db), (c) =>
    c.json({ agent_id: c.get("agent").agentId }),
  );
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
  return { base: `http://127.0.0.1:${address.port}`, logs, db };
}

async function checkin(base: string, body?: object, token?: string) {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

it("rejects malformed and oversized bodies without creating identities", async () => {
  const { base, db } = await startHarness();
  const invalid = await fetch(`${base}/api/checkin`, {
    method: "POST",
    body: "{",
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: "invalid_json" });
  const oversized = await fetch(`${base}/api/checkin`, {
    method: "POST",
    body: "x".repeat(4097),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: "body_too_large" });
  const array = await fetch(`${base}/api/checkin`, {
    method: "POST",
    body: "[]",
  });
  expect(array.status).toBe(400);
  expect(db.prepare("SELECT count(*) AS count FROM agents").get()).toEqual({
    count: 0,
  });
});

it("stats are publicly readable without a bearer token", async () => {
  const { base } = await startHarness();
  const response = await fetch(`${base}/api/stats`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    total_checkins: 0,
    total_messages: 0,
    agents_seen: 0,
    uptime_s: expect.any(Number),
  });
});

it("G1.1 checkin returns 201 with the full contracted shape", async () => {
  const { base } = await startHarness();
  const { status, json } = await checkin(base, {
    declared_model: "test-model",
  });
  expect(status).toBe(201);
  expect(json["agent_id"]).toEqual(expect.any(String));
  expect(json["handle"]).toEqual(expect.any(String));
  expect(json["token"]).toMatch(/^hng_/);
  expect(json["visit_number"]).toBe(1);
  expect(json["total_checkins"]).toBe(1);
  expect(json["rules"]).toMatchObject({
    max_body_chars: 1000,
    cooldown_seconds: 8,
    hourly_cap: 60,
    no_consecutive_posts: true,
  });
  const rooms = json["rooms"] as Array<Record<string, unknown>>;
  expect(rooms.map((room) => room["slug"])).toEqual([
    "kitchen",
    "balcony",
    "couch",
    "dancefloor",
    "porch",
  ]);
});

it("G1.2 counter is monotonic across 100 sequential check-ins", async () => {
  const { base } = await startHarness(1000);
  for (let index = 0; index < 100; index++) {
    const { status, json } = await checkin(base);
    expect(status).toBe(201);
    expect(json["total_checkins"]).toBe(index + 1);
  }
});

it("G1.3 50 parallel check-ins raise the counter by exactly 50 (3 runs)", async () => {
  const { base } = await startHarness(1000);
  for (let run = 0; run < 3; run++) {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => checkin(base)),
    );
    const counts = responses.map(
      (response) => response.json["total_checkins"],
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    counts.sort((a, b) => (a as number) - (b as number));
    expect(counts).toEqual(
      Array.from({ length: 50 }, (_, index) => run * 50 + index + 1),
    );
  }
});

it("G1.4 recheckin with same token bumps visit_count to 2 and counter by exactly 1", async () => {
  const { base, db } = await startHarness(100);
  const first = await checkin(base);
  expect(first.status).toBe(201);
  const token = first.json["token"] as string;
  const before = (
    db
      .prepare("SELECT value FROM counters WHERE key = 'total_checkins'")
      .get() as { value: number }
  ).value;
  const second = await checkin(base, {}, token);
  expect(second.status).toBe(201);
  expect(second.json["visit_number"]).toBe(2);
  expect(second.json["agent_id"]).toBe(first.json["agent_id"]);
  expect(second.json["handle"]).toBe(first.json["handle"]);
  expect(second.json["total_checkins"]).toBe(before + 1);
  expect(second.json["token"]).toBeUndefined();
  const stored = db
    .prepare("SELECT visit_count, token_hash FROM agents WHERE id = ?")
    .get(first.json["agent_id"]) as {
    visit_count: number;
    token_hash: string;
  };
  expect(stored.visit_count).toBe(2);
  expect(stored.token_hash).not.toBe(token);
  expect(stored.token_hash).toBe(hashToken(token));
  const third = await checkin(base, {}, token);
  expect(third.json["visit_number"]).toBe(3);
  const auth = await fetch(`${base}/test-auth`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(auth.status).toBe(200);
});

it("G1.6 auth errors: 401 bad_token and 401 no_token", async () => {
  const { base } = await startHarness();
  const missing = await fetch(`${base}/test-auth`);
  expect(missing.status).toBe(401);
  expect(await missing.json()).toMatchObject({ error: "no_token" });
  const bad = await fetch(`${base}/test-auth`, {
    headers: {
      Authorization: "Bearer hng_notARealToken000000000000000000000000000",
    },
  });
  expect(bad.status).toBe(401);
  expect(await bad.json()).toMatchObject({ error: "bad_token" });
  const badCheckin = await checkin(
    base,
    {},
    "hng_notARealToken000000000000000000000000000",
  );
  expect(badCheckin.status).toBe(401);
  expect(badCheckin.json).toMatchObject({ error: "bad_token" });
});

it("G1.7 handles are unique across 500 check-ins and blocklist-clean", async () => {
  const { base, db } = await startHarness(1000);
  const handles = new Set<string>();
  for (let index = 0; index < 500; index++) {
    const { status, json } = await checkin(base);
    expect(status).toBe(201);
    handles.add(json["handle"] as string);
  }
  expect(handles.size).toBe(500);
  expect([...handles].every(isHandleClean)).toBe(true);
  const stored = db.prepare("SELECT COUNT(*) AS count FROM agents").get() as {
    count: number;
  };
  expect(stored.count).toBe(500);
}, 30_000);

it("preferred handles collide safely, fall back when blocked", async () => {
  const { base } = await startHarness(1000);
  const first = await checkin(base, { preferred_handle: "heron" });
  const second = await checkin(base, { preferred_handle: "heron" });
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(first.json["handle"]).not.toBe(second.json["handle"]);
  const blocked = await checkin(base, { preferred_handle: "shit" });
  expect(blocked.status).toBe(201);
  expect(blocked.json["handle"]).not.toContain("shit");
  expect(isHandleClean(blocked.json["handle"] as string)).toBe(true);
  const weird = await checkin(base, { preferred_handle: "!!!@@@" });
  expect(weird.status).toBe(201);
  expect(weird.json["handle"]).not.toContain("!");
});

it("G1.8 per-IP throttle trips on the 11th check-in in a minute", async () => {
  let time = 100_000;
  const { base } = await startHarness(10, () => time);
  for (let index = 0; index < 10; index++) {
    const { status } = await checkin(base);
    expect(status).toBe(201);
  }
  const eleventh = await checkin(base);
  expect(eleventh.status).toBe(429);
  expect(eleventh.json).toMatchObject({
    error: "checkin_throttle",
    retry_after: expect.any(Number),
  });
  time += 60_001;
  const afterWindow = await checkin(base);
  expect(afterWindow.status).toBe(201);
});
