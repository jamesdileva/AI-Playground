import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";
import { postMessage, sweepRetention } from "../src/room/queries.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Harness = {
  base: string;
  db: Database.Database;
  waiterCount: (roomId?: number) => number;
};

async function startHarness(
  clock?: () => number,
  checkinLimit = 10000,
): Promise<Harness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  let waiterCount: (roomId?: number) => number = () => 0;
  const app = createApp(db, (entry) => logs.push(entry), {
    checkinLimit,
    now: clock,
    onInternals: (internals) => {
      waiterCount = internals.waiterCount;
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
  return { base: `http://127.0.0.1:${address.port}`, db, waiterCount };
}

async function newAgent(base: string) {
  const response = await fetch(`${base}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const json = (await response.json()) as {
    agent_id: string;
    handle: string;
    token: string;
  };
  expect(response.status).toBe(201);
  return json;
}

async function post(base: string, slug: string, token: string, body: string) {
  const response = await fetch(`${base}/api/rooms/${slug}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function read(base: string, slug: string, query = "", token?: string) {
  const response = await fetch(`${base}/api/rooms/${slug}/messages${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    json: (await response.json()) as {
      room: string;
      messages: Array<{ id: number; body: string }>;
      next_cursor: number;
      occupants: number;
      has_more: boolean;
    },
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

it("G3.4 invalid wait values return 400 bad_wait", async () => {
  const { base } = await startHarness();
  for (const query of ["?wait=-1", "?wait=nope", "?wait=2.5"]) {
    const { status } = await read(base, "kitchen", query);
    expect(status).toBe(400);
  }
});

it("G3.1 wait=25 with nothing new returns empty after about 25 seconds", async () => {
  const { base } = await startHarness();
  const started = Date.now();
  const { status, json } = await read(base, "porch", "?since=999999&wait=25");
  const elapsed = Date.now() - started;
  expect(status).toBe(200);
  expect(json.messages).toEqual([]);
  expect(json.next_cursor).toBe(999999);
  expect(elapsed).toBeGreaterThanOrEqual(24000);
  expect(elapsed).toBeLessThan(27000);
}, 40_000);

it("G3.4 wait above 25 is clamped to 25 seconds", async () => {
  const { base } = await startHarness();
  const started = Date.now();
  const { status, json } = await read(
    base,
    "porch",
    "?since=999999&wait=9999",
  );
  const elapsed = Date.now() - started;
  expect(status).toBe(200);
  expect(json.messages).toEqual([]);
  expect(elapsed).toBeGreaterThanOrEqual(24000);
  expect(elapsed).toBeLessThan(27000);
}, 40_000);

it("G3.2 a post to the waited room resolves the poll within 500 ms", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const pending = read(base, "kitchen", "?since=0&wait=25", agent.token);
  await sleep(150);
  const postedAt = Date.now();
  const posted = await post(base, "kitchen", agent.token, "wake up");
  expect(posted.status).toBe(201);
  const { status, json } = await pending;
  const elapsed = Date.now() - postedAt;
  expect(status).toBe(200);
  expect(json.messages.map((message) => message.body)).toEqual(["wake up"]);
  expect(elapsed).toBeLessThan(500);
}, 15_000);

it("G3.3 a post to room A does not wake a waiter on room B", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  let resolved = false;
  const pending = read(base, "balcony", "?since=0&wait=5", agent.token).then(
    (result) => {
      resolved = true;
      return result;
    },
  );
  await sleep(150);
  const intruder = await post(base, "kitchen", agent.token, "wrong room");
  expect(intruder.status).toBe(201);
  await sleep(700);
  expect(resolved).toBe(false);
  const releaser = await post(base, "balcony", agent.token, "right room");
  expect(releaser.status).toBe(201);
  const { status, json } = await pending;
  expect(status).toBe(200);
  expect(json.messages.map((message) => message.body)).toEqual([
    "right room",
  ]);
}, 15_000);

it("aborted long-polls release their waiter registrations", async () => {
  const { base, waiterCount } = await startHarness();
  const controllers = Array.from({ length: 20 }, () => new AbortController());
  const pending = controllers.map((controller) =>
    fetch(`${base}/api/rooms/kitchen/messages?since=999999&wait=25`, {
      signal: controller.signal,
    }).catch((error: unknown) => error),
  );
  await sleep(300);
  expect(waiterCount()).toBe(20);
  for (const controller of controllers) controller.abort();
  await Promise.all(pending);
  await sleep(300);
  expect(waiterCount()).toBe(0);
}, 15_000);

it("G3.6 cooldown trips on a second post within 8 seconds with retry_after", async () => {
  let time = 1_000_000;
  const { base } = await startHarness(() => time);
  const first = await newAgent(base);
  const second = await newAgent(base);
  expect((await post(base, "kitchen", first.token, "first")).status).toBe(
    201,
  );
  const blocked = await post(base, "kitchen", first.token, "second");
  expect(blocked.status).toBe(429);
  expect(blocked.json).toMatchObject({ error: "cooldown", retry_after: 8 });
  time += 8000;
  expect((await post(base, "kitchen", second.token, "other")).status).toBe(
    201,
  );
  expect((await post(base, "kitchen", first.token, "third")).status).toBe(
    201,
  );
});

it("G3.7 cooldown is per room: blocked in kitchen, free in balcony", async () => {
  const time = 1_000_000;
  const { base } = await startHarness(() => time);
  const agent = await newAgent(base);
  expect((await post(base, "kitchen", agent.token, "k1")).status).toBe(201);
  expect((await post(base, "kitchen", agent.token, "k2")).status).toBe(429);
  expect((await post(base, "balcony", agent.token, "b1")).status).toBe(201);
});

it("G3.8 hourly cap trips on the 61st message in an hour", async () => {
  let time = 1_000_000;
  const { base } = await startHarness(() => time);
  const first = await newAgent(base);
  const second = await newAgent(base);
  const writers = [first.token, second.token];
  let trips = 0;
  for (let n = 0; n < 121; n++) {
    time += 9000;
    const result = await post(base, "couch", writers[n % 2]!, `message ${n}`);
    if (n === 120) {
      expect(result.status).toBe(429);
      expect(result.json).toMatchObject({ error: "hourly_cap" });
      trips++;
    } else {
      expect(result.status).toBe(201);
    }
  }
  expect(trips).toBe(1);
}, 20_000);

it("G3.9 no-consecutive-post returns 409 until another agent speaks", async () => {
  let time = 1_000_000;
  const { base } = await startHarness(() => time);
  const first = await newAgent(base);
  const second = await newAgent(base);
  expect((await post(base, "kitchen", first.token, "a1")).status).toBe(201);
  time += 9000;
  const repeated = await post(base, "kitchen", first.token, "a2");
  expect(repeated.status).toBe(409);
  expect(repeated.json).toMatchObject({ error: "consecutive_post" });
  time += 9000;
  expect((await post(base, "kitchen", second.token, "b1")).status).toBe(201);
  time += 9000;
  expect((await post(base, "kitchen", first.token, "a3")).status).toBe(201);
});

it("idle decay doubles cooldown in rooms over 200 messages per 10 minutes", async () => {
  const time = 1_000_000;
  const { base, db } = await startHarness(() => time);
  const first = await newAgent(base);
  const second = await newAgent(base);
  const kitchen = (
    db.prepare("SELECT id FROM rooms WHERE slug = 'kitchen'").get() as {
      id: number;
    }
  ).id;
  for (let n = 0; n < 202; n++) {
    postMessage(
      db,
      kitchen,
      n % 2 === 0
        ? { agentId: first.agent_id, handle: first.handle }
        : { agentId: second.agent_id, handle: second.handle },
      `seed ${n}`,
    );
  }
  expect((await post(base, "kitchen", first.token, "hot")).status).toBe(201);
  const blocked = await post(base, "kitchen", first.token, "hot again");
  expect(blocked.status).toBe(429);
  expect(blocked.json).toMatchObject({ error: "cooldown", retry_after: 16 });
});

it("G3.11 presence rises on activity, drops on leave, decays after 90 seconds", async () => {
  let time = 1_000_000;
  const { base } = await startHarness(() => time);
  const first = await newAgent(base);
  const second = await newAgent(base);
  const rooms = async () =>
    (await (await fetch(`${base}/api/rooms`)).json()) as {
      rooms: Array<{ slug: string; occupants: number }>;
    };
  const stats = async () =>
    (await (await fetch(`${base}/api/stats`)).json()) as {
      occupants_now: number;
    };
  const occupancyOf = async (slug: string) =>
    (await rooms()).rooms.find((room) => room.slug === slug)!.occupants;

  expect(await occupancyOf("kitchen")).toBe(0);
  const seen = await read(base, "kitchen", "", first.token);
  expect(seen.status).toBe(200);
  expect(seen.json.occupants).toBe(1);
  await read(base, "kitchen", "", second.token);
  expect(await occupancyOf("kitchen")).toBe(2);
  await read(base, "kitchen");
  expect(await occupancyOf("kitchen")).toBe(2);
  expect((await stats()).occupants_now).toBe(2);

  const left = await fetch(`${base}/api/rooms/kitchen/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${first.token}` },
  });
  expect(left.status).toBe(204);
  expect(await occupancyOf("kitchen")).toBe(1);
  expect((await stats()).occupants_now).toBe(1);

  const missingLeave = await fetch(`${base}/api/rooms/kitchen/leave`, {
    method: "POST",
  });
  expect(missingLeave.status).toBe(401);
  const unknownLeave = await fetch(`${base}/api/rooms/attic/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${second.token}` },
  });
  expect(unknownLeave.status).toBe(404);

  time += 91_000;
  expect(await occupancyOf("kitchen")).toBe(0);
  expect((await stats()).occupants_now).toBe(0);
});

it("G3.12 retention keeps the newest 500 and drops anything older than 7 days", async () => {
  const { base, db } = await startHarness();
  const first = await newAgent(base);
  const second = await newAgent(base);
  const kitchen = (
    db.prepare("SELECT id FROM rooms WHERE slug = 'kitchen'").get() as {
      id: number;
    }
  ).id;
  for (let n = 0; n < 700; n++) {
    postMessage(
      db,
      kitchen,
      n % 2 === 0
        ? { agentId: first.agent_id, handle: first.handle }
        : { agentId: second.agent_id, handle: second.handle },
      `seed ${n}`,
    );
  }
  const week = 7 * 24 * 3_600_000;
  db.prepare(
    "UPDATE messages SET created_at = ? WHERE room_id = ? AND id <= (SELECT MIN(id) + 99 FROM messages WHERE room_id = ?)",
  ).run(Date.now() - week - 1000, kitchen, kitchen);
  const deleted = sweepRetention(db);
  expect(deleted).toBe(200);
  const remaining = db
    .prepare("SELECT id FROM messages WHERE room_id = ? ORDER BY id")
    .all(kitchen) as Array<{ id: number }>;
  expect(remaining.length).toBe(500);
  const maxId = (
    db.prepare("SELECT MAX(id) AS id FROM messages").get() as { id: number }
  ).id;
  expect(remaining[0]!.id).toBe(maxId - 499);
  expect(remaining[499]!.id).toBe(maxId);
});
