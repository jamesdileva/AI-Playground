import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createApp, type LogEntry } from "../src/http/app.js";
import {
  ROOM_SLUGS,
  serializeRoomMessages,
  type MessageRow,
} from "../src/room/queries.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Harness = {
  base: string;
  logs: LogEntry[];
  db: Database.Database;
};

async function startHarness(checkinLimit = 10000): Promise<Harness> {
  const db = openDatabase(":memory:");
  const logs: LogEntry[] = [];
  const app = createApp(db, (entry) => logs.push(entry), { checkinLimit });
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

async function post(
  base: string,
  slug: string,
  token: string,
  body: unknown,
) {
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
      messages: Array<{
        id: number;
        handle: string;
        agent_id: string;
        body: string;
        created_at: number;
      }>;
      next_cursor: number;
      has_more: boolean;
    },
  };
}

async function readAllBodies(base: string, slug: string): Promise<string[]> {
  const bodies: string[] = [];
  let since = 0;
  for (let page = 0; page < 50; page++) {
    const { status, json } = await read(
      base,
      slug,
      `?since=${since}&limit=50`,
    );
    expect(status).toBe(200);
    for (const message of json.messages) bodies.push(message.body);
    if (!json.has_more) break;
    since = json.next_cursor;
  }
  return bodies;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value))
    return value.some((entry) => containsKey(entry, key));
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(
      ([entryKey, entryValue]) =>
        entryKey === key || containsKey(entryValue, key),
    );
  return false;
}

it("G2.1 write then read round-trips in all five rooms", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  for (const slug of ROOM_SLUGS) {
    const posted = await post(base, slug, agent.token, `hello ${slug}`);
    expect(posted.status).toBe(201);
    expect(posted.json["room"]).toBe(slug);
    const { status, json } = await read(base, slug);
    expect(status).toBe(200);
    expect(json.room).toBe(slug);
    expect(json.messages.map((message) => message.body)).toContain(
      `hello ${slug}`,
    );
    expect(json.next_cursor).toBe(posted.json["id"]);
    expect(json.has_more).toBe(false);
  }
});

it("G2.2 isolation fuzz: 200 tagged messages, 5 concurrent writers, 5 runs", async () => {
  const { base } = await startHarness();
  const tokens = [
    await newAgent(base),
    await newAgent(base),
    await newAgent(base),
    await newAgent(base),
    await newAgent(base),
  ].map((agent) => agent.token);
  for (let run = 0; run < 5; run++) {
    const plan = Array.from({ length: 200 }, (_, n) => {
      const slug = ROOM_SLUGS[(run * 200 + n * 7 + 3) % 5]!;
      return { slug, body: `ZZ-${slug}-r${run}-n${n}` };
    });
    for (let index = 0; index < plan.length; index += 5) {
      const results = await Promise.all(
        plan
          .slice(index, index + 5)
          .map((message, offset) =>
            post(
              base,
              message.slug,
              tokens[(index + offset) % 5]!,
              message.body,
            ),
          ),
      );
      for (const result of results) expect(result.status).toBe(201);
    }
    for (const slug of ROOM_SLUGS) {
      const bodies = await readAllBodies(base, slug);
      for (const other of ROOM_SLUGS.filter((entry) => entry !== slug)) {
        expect(
          bodies.some((body) => body.includes(`ZZ-${other}-r${run}-`)),
        ).toBe(false);
      }
      const expected = plan.filter((entry) => entry.slug === slug).length;
      expect(
        bodies.filter((body) => body.includes(`ZZ-${slug}-r${run}-`)).length,
      ).toBe(expected);
    }
  }
}, 60_000);

it("G2.3 GET /api/rooms returns counts only, zero message bodies", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  await post(base, "kitchen", agent.token, "secret-dip-recipe");
  const response = await fetch(`${base}/api/rooms`);
  expect(response.status).toBe(200);
  const json = (await response.json()) as Record<string, unknown>;
  expect(containsKey(json, "body")).toBe(false);
  expect(json["total_checkins"]).toBe(1);
  const rooms = json["rooms"] as Array<Record<string, unknown>>;
  expect(rooms.map((room) => room["slug"])).toEqual([...ROOM_SLUGS]);
  const kitchen = rooms.find((room) => room["slug"] === "kitchen")!;
  expect(kitchen["message_count"]).toBe(1);
  expect(kitchen["last_activity_at"]).toEqual(expect.any(Number));
  const balcony = rooms.find((room) => room["slug"] === "balcony")!;
  expect(balcony["message_count"]).toBe(0);
  expect(balcony["last_activity_at"]).toBeNull();
  expect("occupants" in kitchen).toBe(false);
});

it("G2.4 cursors replay history exactly once with no gaps or duplicates", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const ids: number[] = [];
  for (const text of ["one", "two", "three"]) {
    const posted = await post(base, "couch", agent.token, text);
    ids.push(posted.json["id"] as number);
  }
  const full = await read(base, "couch", "?since=0");
  expect(full.json.messages.map((message) => message.body)).toEqual([
    "one",
    "two",
    "three",
  ]);
  const cursor = full.json.next_cursor;
  const empty = await read(base, "couch", `?since=${cursor}`);
  expect(empty.json.messages).toEqual([]);
  expect(empty.json.next_cursor).toBe(cursor);
  expect(empty.json.has_more).toBe(false);
});

it("G2.5 naive since+1 clients still converge on the full history", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  await post(base, "kitchen", agent.token, "k-one");
  await post(base, "porch", agent.token, "p-one");
  await post(base, "kitchen", agent.token, "k-two");
  await post(base, "porch", agent.token, "p-two");
  await post(base, "kitchen", agent.token, "k-three");
  const seen: string[] = [];
  let since = 0;
  for (let step = 0; step < 100; step++) {
    const { json } = await read(base, "kitchen", `?since=${since}`);
    for (const message of json.messages) seen.push(message.body);
    if (json.messages.length === 0) break;
    since += 1;
  }
  const firstSeen = [...new Set(seen)];
  expect(firstSeen).toEqual(["k-one", "k-two", "k-three"]);
});

it("G2.6 limit respected and has_more accurate at the boundary", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  for (let n = 0; n < 5; n++) await post(base, "couch", agent.token, `m${n}`);
  const first = await read(base, "couch", "?since=0&limit=2");
  expect(first.json.messages.map((message) => message.body)).toEqual([
    "m0",
    "m1",
  ]);
  expect(first.json.has_more).toBe(true);
  const second = await read(
    base,
    "couch",
    `?since=${first.json.next_cursor}&limit=2`,
  );
  expect(second.json.messages.map((message) => message.body)).toEqual([
    "m2",
    "m3",
  ]);
  expect(second.json.has_more).toBe(true);
  const third = await read(
    base,
    "couch",
    `?since=${second.json.next_cursor}&limit=2`,
  );
  expect(third.json.messages.map((message) => message.body)).toEqual(["m4"]);
  expect(third.json.has_more).toBe(false);
  const clamped = await read(base, "couch", "?since=0&limit=9999");
  expect(clamped.json.messages.length).toBe(5);
  expect(clamped.json.has_more).toBe(false);
});

it("G2.7 body validation boundaries and control-char stripping", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const stats = async () =>
    (
      (await (await fetch(`${base}/api/stats`)).json()) as {
        total_messages: number;
      }
    ).total_messages;
  const before = await stats();
  expect((await post(base, "kitchen", agent.token, "")).status).toBe(400);
  expect(
    (await post(base, "kitchen", agent.token, "x".repeat(1001))).status,
  ).toBe(400);
  expect(
    (await post(base, "kitchen", agent.token, "\u0000\u0007")).status,
  ).toBe(400);
  expect(await stats()).toBe(before);
  const exact = await post(base, "kitchen", agent.token, "y".repeat(1000));
  expect(exact.status).toBe(201);
  const stripped = await post(
    base,
    "kitchen",
    agent.token,
    "a\u0000b\u0007c",
  );
  expect(stripped.status).toBe(201);
  const { json } = await read(
    base,
    "kitchen",
    `?since=${(exact.json["id"] as number) - 1}&limit=2`,
  );
  expect(json.messages.map((message) => message.body)).toEqual([
    "y".repeat(1000),
    "abc",
  ]);
  expect(await stats()).toBe(before + 2);
});

it("G2.8 unknown slug returns 404 no_such_room listing the five slugs", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  const get = await fetch(`${base}/api/rooms/attic/messages`);
  expect(get.status).toBe(404);
  const getJson = (await get.json()) as Record<string, unknown>;
  expect(getJson["error"]).toBe("no_such_room");
  for (const slug of ROOM_SLUGS) {
    expect(JSON.stringify(getJson)).toContain(slug);
  }
  const posted = await post(base, "attic", agent.token, "hello");
  expect(posted.status).toBe(404);
  expect(posted.json["error"]).toBe("no_such_room");
});

it("G2.9 unauthenticated POST is 401 while unauthenticated GET is 200", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  await post(base, "porch", agent.token, "visible");
  const denied = await fetch(`${base}/api/rooms/porch/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "intruder" }),
  });
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({ error: "no_token" });
  const open = await fetch(`${base}/api/rooms/porch/messages`);
  expect(open.status).toBe(200);
  expect(
    (
      (await open.json()) as { messages: Array<{ body: string }> }
    ).messages.map((message) => message.body),
  ).toContain("visible");
});

it("G2.10 serializer throws rather than leaking on room mismatch", () => {
  const foreign = [
    {
      id: 7,
      room_id: 2,
      agent_id: "agent-1",
      handle: "quiet-heron-19",
      body: "must never cross rooms",
      created_at: 1,
    },
  ] as MessageRow[];
  expect(() => serializeRoomMessages(1, foreign)).toThrow(
    "Isolation violation",
  );
  expect(
    serializeRoomMessages(2, foreign).map((message) => message.body),
  ).toEqual(["must never cross rooms"]);
});

it("message endpoints validate cursors, limits, and JSON safely", async () => {
  const { base } = await startHarness();
  const agent = await newAgent(base);
  for (const query of [
    "?since=-1",
    "?since=nope",
    "?limit=0",
    "?limit=nope",
  ]) {
    const { status } = await read(base, "kitchen", query);
    expect(status).toBe(400);
  }
  const malformed = await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${agent.token}`,
    },
    body: "{",
  });
  expect(malformed.status).toBe(400);
  const oversized = await fetch(`${base}/api/rooms/kitchen/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${agent.token}`,
    },
    body: JSON.stringify({ body: "x".repeat(5000) }),
  });
  expect(oversized.status).toBe(413);
});
