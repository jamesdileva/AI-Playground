import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import {
  createApp,
  type LogEntry,
  type VolumeReport,
} from "../src/http/app.js";
import type { MessageLimits } from "../src/http/rateLimit.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Harness = { base: string; db: Database.Database };

async function startHarness(
  options: {
    checkinLimit?: number;
    messageLimits?: MessageLimits;
  } = {},
): Promise<Harness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  const reports: VolumeReport[] = [];
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit: 10000,
    ...options,
    onVolume: (report) => reports.push(report),
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
  return { base: `http://127.0.0.1:${address.port}`, db };
}

async function checkin(base: string, body = "{}") {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function post(
  base: string,
  slug: string,
  token: string | undefined,
  body: unknown,
  raw?: string,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/api/rooms/${slug}/messages`, {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

function expectHinted(json: Record<string, unknown>, error: string) {
  expect(json.error).toBe(error);
  expect(typeof json.message).toBe("string");
  expect((json.message as string).length).toBeGreaterThan(0);
  expect(typeof json.hint).toBe("string");
  expect((json.hint as string).length).toBeGreaterThan(0);
}

it("5.4: every 400 is reachable with an actionable hint", async () => {
  const { base } = await startHarness();
  const agent = await checkin(base);
  const token = agent.json.token as string;

  const empty = await post(base, "kitchen", token, {});
  expect(empty.status).toBe(400);
  expectHinted(empty.json, "body_invalid");

  const blank = await post(base, "kitchen", token, {
    body: String.fromCharCode(0, 7),
  });
  expect(blank.status).toBe(400);
  expectHinted(blank.json, "body_invalid");

  const long = await post(base, "kitchen", token, {
    body: "x".repeat(1001),
  });
  expect(long.status).toBe(400);
  expectHinted(long.json, "body_invalid");

  const badCursor = await fetch(
    `${base}/api/rooms/kitchen/messages?since=abc`,
  );
  expect(badCursor.status).toBe(400);
  expectHinted(
    (await badCursor.json()) as Record<string, unknown>,
    "bad_cursor",
  );

  const badLimit = await fetch(`${base}/api/rooms/kitchen/messages?limit=0`);
  expect(badLimit.status).toBe(400);
  expectHinted(
    (await badLimit.json()) as Record<string, unknown>,
    "bad_limit",
  );

  const badWait = await fetch(`${base}/api/rooms/kitchen/messages?wait=nope`);
  expect(badWait.status).toBe(400);
  expectHinted((await badWait.json()) as Record<string, unknown>, "bad_wait");

  const badJson = await post(base, "kitchen", token, null, "{oops");
  expect(badJson.status).toBe(400);
  expectHinted(badJson.json, "invalid_json");
});

it("5.4: auth, room, and conflict errors carry hints", async () => {
  const { base } = await startHarness();
  const agent = await checkin(base);
  const token = agent.json.token as string;

  const noToken = await post(base, "kitchen", undefined, { body: "hi" });
  expect(noToken.status).toBe(401);
  expectHinted(noToken.json, "no_token");

  const badToken = await post(base, "kitchen", "hng_deadbeef", {
    body: "hi",
  });
  expect(badToken.status).toBe(401);
  expectHinted(badToken.json, "bad_token");

  const noRoom = await fetch(`${base}/api/rooms/cellar/messages?since=0`);
  expect(noRoom.status).toBe(404);
  expectHinted(
    (await noRoom.json()) as Record<string, unknown>,
    "no_such_room",
  );

  const notFound = await fetch(`${base}/api/definitely-not-here`);
  expect(notFound.status).toBe(404);
  expectHinted(
    (await notFound.json()) as Record<string, unknown>,
    "not_found",
  );

  const first = await post(base, "kitchen", token, { body: "one" });
  expect(first.status).toBe(201);
  const second = await post(base, "kitchen", token, { body: "two" });
  expect(second.status).toBe(429);
  expectHinted(second.json, "cooldown");

  const other = await checkin(base);
  const third = await post(base, "kitchen", other.json.token as string, {
    body: "three",
  });
  expect(third.status).toBe(201);
  await new Promise((resolve) => setTimeout(resolve, 8200));
  const fourth = await post(base, "kitchen", token, { body: "four" });
  expect(fourth.status).toBe(201);
  await new Promise((resolve) => setTimeout(resolve, 8200));
  const fifth = await post(base, "kitchen", token, { body: "five" });
  expect(fifth.status).toBe(409);
  expectHinted(fifth.json, "consecutive_post");
}, 30000);

it("5.4: oversized bodies are rejected with a hint", async () => {
  const { base } = await startHarness();
  const agent = await checkin(base);
  const big = await post(base, "kitchen", agent.json.token as string, {
    body: "x".repeat(5000),
  });
  expect(big.status).toBe(413);
  expectHinted(big.json, "body_too_large");
});

it("5.4: hourly cap trips with retry_after", async () => {
  const { base } = await startHarness({
    messageLimits: { cooldownMs: 0, hourlyCap: 2 },
  });
  const agent = await checkin(base);
  const token = agent.json.token as string;
  const other = await checkin(base);
  const otherToken = other.json.token as string;
  expect((await post(base, "kitchen", token, { body: "a" })).status).toBe(
    201,
  );
  expect(
    (await post(base, "kitchen", otherToken, { body: "b" })).status,
  ).toBe(201);
  expect((await post(base, "kitchen", token, { body: "c" })).status).toBe(
    201,
  );
  expect(
    (await post(base, "kitchen", otherToken, { body: "d" })).status,
  ).toBe(201);
  const capped = await post(base, "kitchen", token, { body: "e" });
  expect(capped.status).toBe(429);
  expectHinted(capped.json, "hourly_cap");
  expect(typeof capped.json.retry_after).toBe("number");
});

it("5.4: check-in throttle trips with retry_after", async () => {
  const { base } = await startHarness({ checkinLimit: 2 });
  expect((await checkin(base)).status).toBe(201);
  expect((await checkin(base)).status).toBe(201);
  const throttled = await checkin(base);
  expect(throttled.status).toBe(429);
  expectHinted(throttled.json, "checkin_throttle");
  expect(typeof throttled.json.retry_after).toBe("number");
});

it("5.4: all 429s carry retry_after", async () => {
  const { base } = await startHarness();
  const agent = await checkin(base);
  const token = agent.json.token as string;
  const first = await post(base, "kitchen", token, { body: "one" });
  expect(first.status).toBe(201);
  const second = await post(base, "kitchen", token, { body: "two" });
  expect(second.status).toBe(429);
  expect(typeof second.json.retry_after).toBe("number");
  expect((second.json.retry_after as number) > 0).toBe(true);
});

it("5.4: dead database yields 503 unavailable with retry_after", async () => {
  const { base, db } = await startHarness();
  db.close();
  const health = await fetch(`${base}/api/health`);
  expect(health.status).toBe(503);
  const healthJson = (await health.json()) as Record<string, unknown>;
  expectHinted(healthJson, "unavailable");
  expect(typeof healthJson.retry_after).toBe("number");
  const broken = await fetch(`${base}/api/rooms/kitchen/messages?since=0`);
  expect(broken.status).toBe(503);
  const brokenJson = (await broken.json()) as Record<string, unknown>;
  expectHinted(brokenJson, "unavailable");
  expect(typeof brokenJson.retry_after).toBe("number");
});
